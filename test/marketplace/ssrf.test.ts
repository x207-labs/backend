import { describe, expect, it } from "vitest";
import { guardedGet, isPublicIp, type Transport } from "../../src/marketplace/ssrf.js";

describe("BE-054 SSRF guard", () => {
  it("TC-BE-054-S1 only global unicast addresses are public", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e"]) expect(isPublicIp(ip), ip).toBe(true);
    for (const ip of [
      "127.0.0.1", "127.255.255.254", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "169.254.0.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
      "192.0.2.1", "198.18.0.1", "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3", "::ffff:169.254.169.254",
      "::ffff:7f00:1", "64:ff9b::a00:1", "not-an-ip", "172.32.0.1x",
    ]) expect(isPublicIp(ip), ip).toBe(false);
    expect(isPublicIp("172.32.0.1")).toBe(true);
    expect(isPublicIp("::ffff:8.8.8.8")).toBe(true);
  });

  const ok: Transport = async () => ({ status: 200, body: Buffer.from("hello"), truncated: false });
  const resolve = (...a: string[]) => async () => a;
  const code = async (p: Promise<unknown>): Promise<string> => p.then(() => "ok", (e) => `${e.status} ${e.code}`);

  it("TC-BE-054-S2 refuses what is not https, port 443, without credentials, or an IP literal that is not public", async () => {
    const opt = { resolver: resolve("8.8.8.8"), transport: ok };
    expect(await code(guardedGet("http://example.com/x", opt))).toBe("403 target_forbidden");
    expect(await code(guardedGet("ftp://example.com/x", opt))).toBe("403 target_forbidden");
    expect(await code(guardedGet("https://example.com:8443/x", opt))).toBe("403 target_forbidden");
    expect(await code(guardedGet("https://user:pw@example.com/x", opt))).toBe("403 target_forbidden");
    expect(await code(guardedGet("https://127.0.0.1/x", opt))).toBe("403 target_forbidden");
    expect(await code(guardedGet("https://169.254.169.254/latest/meta-data", opt))).toBe("403 target_forbidden");
    expect(await code(guardedGet("https://[::1]/x", opt))).toBe("403 target_forbidden");
    expect(await code(guardedGet("https://[::ffff:10.0.0.1]/x", opt))).toBe("403 target_forbidden");
    expect(await code(guardedGet("not a url", opt))).toBe("403 target_forbidden");
    expect(await code(guardedGet("https://example.com/x", { ...opt, code: "source_forbidden" }))).toBe("ok");
    expect(await code(guardedGet("http://example.com/x", { ...opt, code: "source_forbidden" }))).toBe("403 source_forbidden");
  });

  it("TC-BE-054-S3 a DNS name that resolves to a private address is refused, also when only one of its answers is private", async () => {
    for (const bad of ["10.0.0.5", "127.0.0.1", "192.168.0.10", "169.254.169.254", "::1", "fd00::5", "::ffff:10.0.0.5"]) {
      expect(await code(guardedGet("https://evil.example.com/x", { resolver: resolve(bad), transport: ok })), bad).toBe("403 target_forbidden");
    }
    expect(await code(guardedGet("https://evil.example.com/x", { resolver: resolve("8.8.8.8", "10.0.0.5"), transport: ok }))).toBe("403 target_forbidden");
    expect(await code(guardedGet("https://good.example.com/x", { resolver: resolve("8.8.8.8", "2606:4700:4700::1111"), transport: ok }))).toBe("ok");
  });

  it("TC-BE-054-S4 no redirect, at most 4 KB, 5 seconds; a host that is down is just unreachable", async () => {
    const opt = { resolver: resolve("8.8.8.8") };
    expect(await code(guardedGet("https://a.example.com/x", { ...opt, transport: async () => ({ status: 302, body: Buffer.alloc(0), truncated: false }) }))).toBe("403 target_forbidden");
    expect(await code(guardedGet("https://a.example.com/x", { ...opt, transport: async () => ({ status: 200, body: Buffer.alloc(10), truncated: true }) }))).toBe("403 target_forbidden");
    expect(await code(guardedGet("https://a.example.com/x", { ...opt, transport: async () => { throw new Error("timeout"); } }))).toBe("403 target_forbidden");
    expect(await guardedGet("https://a.example.com/x", { ...opt, transport: async () => { throw new Error("ECONNREFUSED"); } })).toEqual({ reachable: false, reason: "connect" });
    expect(await guardedGet("https://a.example.com/x", { resolver: async () => { throw new Error("ENOTFOUND"); }, transport: ok })).toEqual({ reachable: false, reason: "dns" });
    expect(await guardedGet("https://a.example.com/x", { ...opt, transport: ok })).toMatchObject({ reachable: true, status: 200, body: "hello" });
  });

  it("TC-BE-054-S5 the real transport checks the address again when it connects (a name that turns private after the first answer)", async () => {
    let calls = 0;
    // first answer public (passes the check before connecting), second answer private (the answer at connect time)
    const resolver = async () => (++calls === 1 ? ["8.8.8.8"] : ["10.0.0.9"]);
    const result = await guardedGet("https://rebind.example.com/x", { resolver }).then(() => "ok", (e) => `${e.status} ${e.code}`);
    expect(result).toBe("403 target_forbidden");
    expect(calls).toBe(2);
  });
});
