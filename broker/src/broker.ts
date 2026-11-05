import { createViewAccessKeyFn } from "@x207/core";
import { X207ExtraSource } from "@x207/scheme";
import type { Server } from "node:http";
import { NearBrokerChain, type BrokerChain } from "./chain.js";
import { ConfigError, type BrokerConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import { FileAudit, type AuditLog } from "./audit.js";
import { ClassCAdapter } from "./proxy/class-c.js";
import { hostedForbidden, ProviderRegistry } from "./proxy/providers.js";
import { ClassBAdapter } from "./keys/class-b.js";
import { Revoker } from "./revoker.js";
import type { Attestor } from "./attest/index.js";
import { createBrokerHandler, serve } from "./server.js";
import { BrokerStore } from "./store.js";
import { activeGrantIdsOf } from "./grants-api.js";
import { ProviderAccessError, ProviderAccessManager, type ProviderAccessAdapter } from "./provider/index.js";
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
  /** BK-009: answers `GET /attestation`. Default: none (`{"mode":"none"}`), which is true for every deployment of this build. */
  attestor?: Attestor;
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
  // BE-070 (ADR-48): the hosted broker is for the demo; a real secret is not put in it, so it does not even start with one
  const real = hostedForbidden(config.mode ?? "self-hosted", classCProviders, options.env ?? process.env);
  if (real.length > 0) throw new ConfigError(`BROKER_MODE hosted is only for mock providers (mock: true); real providers: ${real.join(", ")}`);
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
  const voucherKeyOf = async (account: string): Promise<string | null> => {
    const r = await (options.fetch ?? fetch)(`${config.readApiUrl.replace(/\/+$/, "")}/x207/circles/${encodeURIComponent(config.circleId)}/members/${encodeURIComponent(account)}`, { signal: AbortSignal.timeout(10_000) });
    return r.ok ? ((await r.json()) as { pubkeyVoucher?: string }).pubkeyVoucher ?? null : null;
  };
  const provider = new ProviderAccessManager({ store, now, circle: config.contractId, voucherKeyOf, mode: config.mode ?? "self-hosted", ...(options.log ? { log: options.log } : {}) });
  for (const adapter of options.providerAdapters ?? []) provider.register(adapter);
  const handler = createBrokerHandler({
    store, now, ...(options.env?.METRICS_TOKEN ?? process.env.METRICS_TOKEN ? { metricsToken: (options.env?.METRICS_TOKEN ?? process.env.METRICS_TOKEN) as string } : {}),
    provider: { manager: provider, contractId: config.contractId, voucherKeyOf, now, limits: config.accessLimits },
    dispatcher, classB, facilitatorUrl: config.facilitatorUrl, circleId: config.circleId, brokerAccount: config.brokerAccount, extra,
    ...(classCProviders.length > 0 ? { proxy: { classC, providers, chain, store, owner: config.secretOwner, mode: config.mode ?? "self-hosted", ...(audit ? { audit } : {}) } } : {}),
    ...(options.attestor ? { attestor: options.attestor } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const { server, url } = await serve(handler, config.port);

  const activeIds = activeGrantIdsOf({ readApiUrl: config.readApiUrl, circle: config.circleId, ...(options.fetch ? { fetch: options.fetch } : {}) });
  /** The access at a provider closes with the grant: revoked on the contract, or its lessee defaulted. */
  const closeProviderAccess = async (event: WatchedEvent): Promise<void> => {
    const ids = event.event === "member_defaulted" ? await activeIds(String(event.data.account_id)) : event.event === "grant_revoked" ? [Number(event.data.grant_id)] : [];
    for (const id of ids) {
      // not guarded by a read here: a first paid rent that is still being made has no row yet, and the read inside `revokeAccess` waits for its turn in the queue of the grant (cross review UM-112, F9)
      try {
        await provider.revokeAccess(id, event.event === "member_defaulted" ? "defaulted" : String(event.data.reason ?? "revoked"));
      } catch (error) {
        if (!(error instanceof ProviderAccessError && error.code === "access_not_found")) throw error;
      }
    }
  };
  const tick = async (): Promise<void> => {
    await watcher.poll(async (event) => {
      await revoker.handle(event);
      await closeProviderAccess(event);
    });
    // BE-096: an error of one entry (DeleteKey or revoke_grant) is logged, not dropped; the revoker repeats the entry in the next tick
    const swept = await revoker.sweep();
    for (const entry of swept.closed) {
      if (entry.error !== undefined) options.log?.(`revoker sweep: grant=${entry.grantId} reason=${entry.reason} keyDeleted=${entry.keyDeleted} revoked=${entry.revoked} error=${entry.error}`);
    }
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
