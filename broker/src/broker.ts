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
import { GrantWatcher } from "./watcher/index.js";

export interface RunningBroker {
  url: string;
  store: BrokerStore;
  revoker: Revoker;
  classB: ClassBAdapter;
  /** The providers of class C; `providers.rotate(assetType)` switches a secret without cutting a grant. */
  providers: ProviderRegistry;
  /** One round: events from the read API, then the clock sweep. Resolves with what the sweep and the watcher closed. */
  tick(): Promise<void>;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** `providers` (class C) and `auditPath` may be left out: no class C and no audit file. */
  config: Omit<BrokerConfig, "providers" | "auditPath"> & Partial<Pick<BrokerConfig, "providers" | "auditPath">>;
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
  const handler = createBrokerHandler({
    dispatcher, classB, facilitatorUrl: config.facilitatorUrl, circleId: config.circleId, brokerAccount: config.brokerAccount, extra,
    ...(classCProviders.length > 0 ? { proxy: { classC, providers, chain, store, ...(audit ? { audit } : {}) } } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const { server, url } = await serve(handler, config.port);

  const tick = async (): Promise<void> => {
    await watcher.poll((event) => revoker.handle(event));
    await revoker.sweep();
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
    url, store, revoker, classB, providers, tick,
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
