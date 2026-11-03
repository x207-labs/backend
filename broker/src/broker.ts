import { createViewAccessKeyFn } from "@x207/core";
import { X207ExtraSource } from "@x207/scheme";
import type { Server } from "node:http";
import { NearBrokerChain, type BrokerChain } from "./chain.js";
import type { BrokerConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import { FileAudit, type AuditLog } from "./audit.js";
import { ClassCAdapter } from "./proxy/class-c.js";
import { ProviderRegistry } from "./proxy/providers.js";
import { ClassBAdapter } from "./keys/class-b.js";
import { Revoker } from "./revoker.js";
import { createBrokerHandler, serve } from "./server.js";
import { BrokerStore } from "./store.js";
import { activeGrantIdsOf } from "./grants-api.js";
import { ProviderAccessManager, type ProviderAccessAdapter } from "./provider/index.js";
import { GrantWatcher, type WatchedEvent } from "./watcher/index.js";

export interface RunningBroker {
  url: string;
  store: BrokerStore;
  revoker: Revoker;
  classB: ClassBAdapter;
  /** P2 access to services of providers: grant, revoke with retry, daily bill of the real cost (BE-057). */
  provider: ProviderAccessManager;
  /** The providers of class C; `providers.rotate(assetType)` switches a secret without cutting a grant. */
  providers: ProviderRegistry;
  /** One round: events from the read API, then the clock sweep. Resolves with what the sweep and the watcher closed. */
  tick(): Promise<void>;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** `providers` (class C) and `auditPath` may be left out: no class C and no audit file. */
  config: Omit<BrokerConfig, "providers" | "auditPath" | "mode"> & Partial<Pick<BrokerConfig, "providers" | "auditPath" | "mode">>;
  /** Adapters of P2 providers (BE-057); `hosted` mode refuses the real ones. */
  providerAdapters?: readonly ProviderAccessAdapter[];
  /** Replaces the NEAR chain (tests). */
  chain?: BrokerChain;
  now?: () => number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** Cache of the `extra` (epoch) read from the facilitator, ms. The default is 60 s; an epoch that turns inside it gives `epoch_mismatch`. */
  extraCacheMs?: number;
  /** Audit log; default: the file of `config.auditPath`, if any. */
  audit?: AuditLog;
  /** Environment that holds the provider secrets (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** Start the poll loop; tests call `tick()` themselves. */
  poll?: boolean;
}

/** BK-002..BK-007 wired together: the lease server, the watcher and the revoker. */
export async function startBroker(options: StartOptions): Promise<RunningBroker> {
  const { config } = options;
  const now = options.now ?? Date.now;
  const chain =
    options.chain ??
    new NearBrokerChain({
      rpcUrl: config.rpcUrl, contractId: config.contractId, brokerAccount: config.brokerAccount, brokerKey: config.brokerKey,
      leaseAccount: config.leaseAccount, leaseKey: config.leaseKey,
    });
  const store = new BrokerStore(config.dbPath);
  const classB = new ClassBAdapter({ chain, store, viewAccessKey: createViewAccessKeyFn({ rpcUrls: [config.rpcUrl], finality: "optimistic" }), now });
  const classCProviders = config.providers ?? [];
  const audit = options.audit ?? (config.auditPath ? new FileAudit(config.auditPath) : undefined);
  const providers = new ProviderRegistry(classCProviders, options.env ?? process.env, audit);
  const classC = new ClassCAdapter({ baseUrl: "", store });
  const dispatcher = new Dispatcher({ chain, adapters: { B: classB, ...(classCProviders.length > 0 ? { C: classC } : {}) } });
  const revoker = new Revoker({
    chain, store, classB, now, activeGrantIdsOf: activeGrantIdsOf({ readApiUrl: config.readApiUrl, circle: config.circleId, ...(options.fetch ? { fetch: options.fetch } : {}) }), ...(options.log ? { log: options.log } : {}) });
  const watcher = new GrantWatcher({
    readApiUrl: config.readApiUrl, circle: config.circleId, store, ...(options.log ? { log: options.log } : {}), ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const extra = new X207ExtraSource({
    facilitatorUrl: config.facilitatorUrl, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.extraCacheMs === undefined ? {} : { cacheMs: options.extraCacheMs }),
  });
  const provider = new ProviderAccessManager({ store, now, mode: config.mode ?? "self-hosted", ...(options.log ? { log: options.log } : {}) });
  for (const adapter of options.providerAdapters ?? []) provider.register(adapter);
  const voucherKeyOf = async (account: string): Promise<string | null> => {
    const r = await (options.fetch ?? fetch)(`${config.readApiUrl.replace(/\/+$/, "")}/x207/circles/${encodeURIComponent(config.circleId)}/members/${encodeURIComponent(account)}`, { signal: AbortSignal.timeout(10_000) });
    return r.ok ? ((await r.json()) as { pubkeyVoucher?: string }).pubkeyVoucher ?? null : null;
  };
  const handler = createBrokerHandler({
    provider: { manager: provider, contractId: config.contractId, voucherKeyOf, now },
    dispatcher, classB, facilitatorUrl: config.facilitatorUrl, circleId: config.circleId, brokerAccount: config.brokerAccount, extra,
    ...(classCProviders.length > 0 ? { proxy: { classC, providers, chain, store, ...(audit ? { audit } : {}) } } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const { server, url } = await serve(handler, config.port);

  const activeIds = activeGrantIdsOf({ readApiUrl: config.readApiUrl, circle: config.circleId, ...(options.fetch ? { fetch: options.fetch } : {}) });
  /** The access at a provider closes with the grant: revoked on the contract, or its lessee defaulted. */
  const closeProviderAccess = async (event: WatchedEvent): Promise<void> => {
    const ids = event.event === "member_defaulted" ? await activeIds(String(event.data.account_id)) : event.event === "grant_revoked" ? [Number(event.data.grant_id)] : [];
    for (const id of ids) {
      const a = provider.access(id);
      if (a !== undefined && a.status === "active") await provider.revokeAccess(id, event.event === "member_defaulted" ? "defaulted" : String(event.data.reason ?? "revoked"));
    }
  };
  const tick = async (): Promise<void> => {
    await watcher.poll(async (event) => {
      await revoker.handle(event);
      await closeProviderAccess(event);
    });
    await revoker.sweep();
    await provider.sweep();
  };
  let timer: NodeJS.Timeout | undefined;
  if (options.poll !== false) {
    const loop = (): void => {
      tick()
        .catch((error: Error) => options.log?.(`tick failed: ${error.message}`))
        .finally(() => {
          timer = setTimeout(loop, config.pollSeconds * 1000);
        });
    };
    loop();
  }
  return {
    url, store, revoker, classB, provider, providers, tick,
    async stop() {
      if (timer) clearTimeout(timer);
      await closeServer(server);
      store.close();
    },
  };
}

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
