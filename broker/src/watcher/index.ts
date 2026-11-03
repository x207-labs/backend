import type { BrokerStore } from "../store.js";

/** One contract event as the read API of M6 serves it (`GET …/events`). */
export interface WatchedEvent {
  receiptId: string;
  logIndex: number;
  blockHeight: number;
  event: string;
  data: Record<string, unknown>;
}

export const WATCHED_EVENTS = ["grant_activated", "grant_revoked", "member_defaulted"] as const;

export interface GrantWatcherOptions {
  readApiUrl: string;
  /** Circle id of the read API path, such as `agents-main`. */
  circle: string;
  store: BrokerStore;
  fetch?: typeof fetch;
  events?: readonly string[];
  pageSize?: number;
  /** Name of the cursor row, so that two watchers in one database do not share a position. */
  name?: string;
  /** Receives one line for each event the handler failed on. */
  log?: (line: string) => void;
}

/** Same encoding as the read API: base64url of `{h, r, i}`, the position of one event. */
export const cursorOf = (e: Pick<WatchedEvent, "blockHeight" | "receiptId" | "logIndex">): string =>
  Buffer.from(JSON.stringify({ h: e.blockHeight, r: e.receiptId, i: e.logIndex }), "utf8").toString("base64url");

/**
 * BK-003: reads `grant_activated`, `grant_revoked` and `member_defaulted` from the read API, oldest first. The position is stored in the
 * database after every event the handler took, so a restart continues where it stopped, and an event is handled at most once per
 * `(receipt_id, log_index)`. A handler that throws is logged and the event is skipped (security review F5): one bad event must not stop every
 * event behind it. The sweep of the revoker still closes what such an event would have closed.
 * (The backup of reading the node directly is not built.)
 */
export class GrantWatcher {
  readonly #o: GrantWatcherOptions;
  readonly #name: string;

  constructor(options: GrantWatcherOptions) {
    this.#o = options;
    this.#name = options.name ?? "events";
  }

  /** Handles every new event and returns how many it handled. */
  async poll(handler: (event: WatchedEvent) => Promise<void> | void): Promise<number> {
    const base = this.#o.readApiUrl.replace(/\/+$/, "");
    const names = (this.#o.events ?? WATCHED_EVENTS).join(",");
    let handled = 0;
    for (;;) {
      const cursor = this.#o.store.cursor(this.#name);
      const url = `${base}/x207/circles/${encodeURIComponent(this.#o.circle)}/events?event=${names}&limit=${this.#o.pageSize ?? 100}${cursor ? `&cursor=${cursor}` : ""}`;
      const response = await (this.#o.fetch ?? fetch)(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`read API ${response.status} for ${url}`);
      const page = (await response.json()) as { items: WatchedEvent[]; more: boolean };
      for (const event of page.items) {
        if (this.#o.store.markSeen(event.receiptId, event.logIndex)) {
          try {
            await handler(event);
            handled += 1;
          } catch (error) {
            (this.#o.log ?? console.error)(`event ${event.event} ${event.receiptId}#${event.logIndex} skipped: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        this.#o.store.setCursor(this.#name, cursorOf(event));
      }
      if (!page.more) return handled;
    }
  }
}
