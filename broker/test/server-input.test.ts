import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { serve } from "../src/server.js";

// B7-P5: one request line or Host that `new Request` refuses used to throw outside the `try` of `serve` and end the process (an unhandled rejection).
function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(text));
    let data = "";
    socket.on("data", (d) => (data += d.toString()));
    socket.on("close", () => resolve(data));
    socket.on("error", () => resolve(data));
    setTimeout(() => socket.destroy(), 1500);
  });
}

describe("BE-070 fix B7-P5 odd request lines and hosts", () => {
  it("TC-BE-078-P5 TRACE, a Host that is not a host, credentials in the Host and an absolute target all get an answer and the server goes on", async () => {
    const unhandled: unknown[] = [];
    const watch = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", watch);
    const { server, url } = await serve(async () => new Response("ok", { status: 200 }));
    const port = Number(new URL(url).port);
    try {
      const status = (answer: string): string => answer.split("\r\n")[0] ?? "";
      expect(status(await raw(port, "TRACE /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"))).toContain("405");
      expect(status(await raw(port, "GET /health HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n"))).toContain("200");
      expect(status(await raw(port, "GET /health HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n"))).toContain("200");
      expect(status(await raw(port, "GET /health HTTP/1.1\r\nHost: a@evil.test\r\nConnection: close\r\n\r\n"))).toContain("200");
      expect(status(await raw(port, "GET http://evil.test/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"))).toContain("400");
      expect(status(await raw(port, "GET //evil.test/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"))).toContain("400");
      expect(status(await raw(port, "GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"))).toContain("200"); // still up
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", watch);
      server.close();
    }
  });
});
