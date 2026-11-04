import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type MockMode = "ok" | "hang" | number;

export interface BlockRequest {
  block_id?: number;
  finality?: string;
}

/** Mock NEAR node: `heights` = existing blocks, the highest is the final head. */
export class MockRpc {
  mode: MockMode = "ok";
  readonly blockRequests: BlockRequest[] = [];
  readonly methods: string[] = [];
  #server: Server | undefined;
  #port = 0;

  constructor(public heights: number[]) {}

  get url(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  get head(): number {
    return Math.max(...this.heights);
  }

  async start(): Promise<this> {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        if (this.mode === "hang") return;
        if (typeof this.mode === "number") {
          res.writeHead(this.mode).end("mock failure");
          return;
        }
        const { id, method, params } = JSON.parse(body) as {
          id: string;
          method: string;
          params: BlockRequest;
        };
        this.methods.push(method);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, ...this.#answer(method, params) }));
      });
    });
    await new Promise<void>((resolve) => server.listen(this.#port, "127.0.0.1", resolve));
    this.#port = (server.address() as AddressInfo).port;
    this.#server = server;
    return this;
  }

  /** Shut down the real server so the client gets a refused connection. */
  async kill(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = undefined;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  #answer(method: string, params: BlockRequest): object {
    if (method !== "block") return { result: { method } };
    this.blockRequests.push(params);
    const height = params.finality === "final" ? this.head : params.block_id;
    if (height === undefined || !this.heights.includes(height)) {
      return {
        error: {
          name: "HANDLER_ERROR",
          cause: { name: "UNKNOWN_BLOCK", info: {} },
          code: -32000,
          message: "Server error",
          data: `DB Not Found Error: BLOCK HEIGHT: ${height}`,
        },
      };
    }
    return { result: { author: "mock", chunks: [], header: { height, hash: `hash-${height}`, timestamp_nanosec: String(height * 1_000_000_000) } } };
  }
}
