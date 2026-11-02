import { createViewAccessKeyFn } from "@x207/core";
import type { Server } from "node:http";
import { NearBrokerChain, type BrokerChain } from "./chain.js";
import type { BrokerConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import { ClassBAdapter } from "./keys/class-b.js";
import { Revoker } from "./revoker.js";
import { createBrokerHandler, serve } from "./server.js";
import { BrokerStore } from "./store.js";
import { GrantWatcher } from "./watcher/index.js";

export interface RunningBroker {
  url: string;
  store: BrokerStore;
  revoker: Revoker;
  classB: ClassBAdapter;
  /** One round: events from the read API, then the clock sweep. Resolves with what the sweep and the watcher closed. */
  tick(): Promise<void>;
  stop(): Promise<void>;
}

export interface StartOptions {
  config: BrokerConfig;
  /** Replaces the NEAR chain (tests). */
  chain?: BrokerChain;
  now?: () => number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
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
  const dispatcher = new Dispatcher({ chain, adapters: { B: classB } });
  const revoker = new Revoker({ chain, store, classB, now, ...(options.log ? { log: options.log } : {}) });
  const watcher = new GrantWatcher({ readApiUrl: config.readApiUrl, circle: config.circleId, store, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const handler = createBrokerHandler({
    dispatcher, classB, facilitatorUrl: config.facilitatorUrl, circleId: config.circleId, brokerAccount: config.brokerAccount,
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
    url, store, revoker, classB, tick,
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
