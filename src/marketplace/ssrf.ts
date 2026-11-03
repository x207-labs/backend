// Guard against server-side request forgery (BE-054 `target-check`, reused by BE-056 for the source of a license). The backend fetches a URL that a user chose, so it must not
// become a way to reach the network of the server. The rules: `https` only, port 443 only, no credentials in the URL, the name is resolved and EVERY address must be public
// (no loopback, private, link-local, metadata 169.254.169.254, CGNAT, multicast, documentation or reserved range, in IPv4 or IPv6, also IPv4 inside IPv6), the address is checked
// again when the socket connects (a name that answers public first and private later cannot get through), no redirect is followed, the body is cut at 4 KB, and the whole
// request has 5 seconds. A violation is `403 target_forbidden` (or `source_forbidden` where the caller says so); a host that answers badly is not a violation, it just does not verify.
import { request } from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { ApiError, type ApiErrorCode } from "../api/errors.js";

export const MAX_BODY_BYTES = 4096;
export const FETCH_TIMEOUT_MS = 5000;

/** Parse an IPv4 or IPv6 literal into 16 bytes (IPv4 as IPv4-mapped); `null` if it is neither. */
export function ipBytes(ip: string): Uint8Array | null {
  const kind = isIP(ip);
  const out = new Uint8Array(16);
  if (kind === 4) {
    ip.split(".").forEach((p, i) => (out[12 + i] = Number(p)));
    out[10] = 0xff;
    out[11] = 0xff;
    return out;
  }
  if (kind !== 6) return null;
  let text = ip.split("%")[0] as string;
  const tailV4 = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tailV4) text = `${tailV4[1]}${(Number(tailV4[2]) * 256 + Number(tailV4[3])).toString(16)}:${(Number(tailV4[4]) * 256 + Number(tailV4[5])).toString(16)}`;
  const halves = text.split("::");
  const head = halves[0] ? (halves[0] as string).split(":") : [];
  const tail = halves.length > 1 && halves[1] ? (halves[1] as string).split(":") : [];
  const groups = halves.length > 1 ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail] : head;
  if (groups.length !== 8) return null;
  groups.forEach((g, i) => {
    const v = parseInt(g as string, 16);
    out[2 * i] = v >> 8;
    out[2 * i + 1] = v & 0xff;
  });
  return out;
}

/** IPv4 ranges that are not global unicast: [base address, prefix length]. */
const V4_BLOCKS: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const v4Number = (ip: string): number => ip.split(".").reduce((n, p) => n * 256 + Number(p), 0);
const inBlock = (n: number, [base, bits]: readonly [string, number]): boolean => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4Number(base) / 2 ** (32 - bits));

/** `true` only for a globally routable unicast address. Anything that does not parse is not public. */
export function isPublicIp(ip: string): boolean {
  const b = ipBytes(ip);
  if (b === null) return false;
  const isMapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  const v4 = (o: number): boolean => !V4_BLOCKS.some((blk) => inBlock(o, blk));
  const embedded = ((b[12] as number) * 2 ** 24) + ((b[13] as number) << 16) + ((b[14] as number) << 8) + (b[15] as number);
  if (isMapped) return v4(embedded);
  // IPv6: the first 80 bits zero is unspecified, loopback, or IPv4-compatible
  if (b.slice(0, 10).every((x) => x === 0)) return false;
  const first = b[0] as number;
  const second = b[1] as number;
  if ((first & 0xfe) === 0xfc) return false; // fc00::/7 unique local
  if (first === 0xfe && (second & 0xc0) === 0x80) return false; // fe80::/10 link local
  if (first === 0xfe && (second & 0xc0) === 0xc0) return false; // fec0::/10 site local
  if (first === 0xff) return false; // multicast
  if (first === 0x20 && second === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false; // 2001:db8::/32 documentation
  if (first === 0x20 && second === 0x01 && b[2] === 0x00 && b[3] === 0x00) return false; // 2001::/32 Teredo
  if (first === 0x20 && second === 0x02) return false; // 2002::/16 6to4
  if (first === 0x00 && second === 0x64 && b[2] === 0xff && b[3] === 0x9b) return !(b[4] === 0x00 && b[5] === 0x01) && v4(embedded); // NAT64 carries an IPv4 address
  return (first & 0xe0) === 0x20; // only 2000::/3 is global unicast today
}

export type Resolver = (host: string) => Promise<string[]>;
export const systemResolver: Resolver = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

export interface Transport {
  (args: { host: string; address: string; path: string; timeoutMs: number; method?: "GET" | "HEAD"; maxBytes?: number; onChunk?: (chunk: Buffer) => void }): Promise<{ status: number; body: Buffer; truncated: boolean }>;
}

/** The real transport: TLS to the address that was checked, with the name for SNI and certificate. The address is checked once more by the `lookup` hook of the socket. */
export const httpsTransport = (resolver: Resolver, forbid: () => never): Transport => ({ host, address, path, timeoutMs, method = "GET", maxBytes = MAX_BODY_BYTES, onChunk }) =>
  new Promise((resolveRaw, rejectRaw) => {
    const resolve = (v: { status: number; body: Buffer; truncated: boolean }): void => done(resolveRaw)(v);
    const reject = (e: unknown): void => done(rejectRaw)(e);
    const lookup: LookupFunction = (_name, opts, cb) => {
      // the address at the moment of connecting must be the checked one, and still public
      const family = isIP(address) === 6 ? 6 : 4;
      const answer = (): void => ((opts as { all?: boolean }).all ? (cb as unknown as (e: null, a: unknown) => void)(null, [{ address, family }]) : cb(null, address, family));
      if (!isPublicIp(address)) return cb(new Error("forbidden address"), "", 4);
      resolver(host).then((now) => (now.length > 0 && now.every(isPublicIp) ? answer() : cb(new Error("forbidden address"), "", 4)), (e: Error) => cb(e, "", 4));
    };
    // `timeout` of the request is only an idle limit of the socket; this is the limit of the whole request
    const deadline = setTimeout(() => req.destroy(new Error("timeout")), timeoutMs);
    const done = <T>(fn: (v: T) => void) => (v: T): void => {
      clearTimeout(deadline);
      fn(v);
    };
    const req = request({ host, port: 443, path, method, lookup, servername: host, timeout: timeoutMs, headers: { "user-agent": "x207-check/1", accept: "text/plain,*/*" } }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          truncated = true;
          req.destroy();
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), truncated });
          return;
        }
        // with a sink the body is handed on and not kept: a large download must not sit in memory
        if (onChunk) onChunk(c);
        else chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), truncated }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => (e.message === "forbidden address" ? (() => { try { forbid(); } catch (x) { reject(x); } })() : reject(e)));
    req.end();
  });

export interface GuardedOptions {
  resolver?: Resolver;
  transport?: Transport;
  /** Error code of a violation: `target_forbidden` (BE-054) or `source_forbidden` (BE-056). */
  code?: ApiErrorCode;
  /** `HEAD` to learn only that the address answers (BE-056). */
  method?: "GET" | "HEAD";
  /** Largest body accepted; default 4 KB. BE-056 raises it to download a ciphertext. */
  maxBytes?: number;
  /** Receives the body piece by piece instead of the result holding it (BE-056: hash and write to a file while it arrives). */
  onChunk?: (chunk: Buffer) => void;
  timeoutMs?: number;
}

export type GuardedResult = { reachable: false; reason: string } | { reachable: true; status: number; body: string; bytes: Buffer };

/**
 * Fetch `https://host/path` under the rules at the head of this file. Throws `ApiError(403, code)` on a violation; a host that is down, answers 4xx/5xx, or is not there
 * gives `{reachable: false}` or a status for the caller to judge. A redirect (3xx) is a violation: the next hop would not be checked by the caller.
 */
export async function guardedGet(rawUrl: string, options: GuardedOptions = {}): Promise<GuardedResult> {
  const code = options.code ?? "target_forbidden";
  const forbid = (message: string, details: Record<string, unknown> = {}): never => {
    throw new ApiError(403, code, message, details);
  };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return forbid("URL tidak sah", { url: rawUrl });
  }
  if (url.protocol !== "https:") forbid("Hanya https yang diperbolehkan", { scheme: url.protocol });
  if (url.username !== "" || url.password !== "") forbid("URL tidak boleh memuat kredensial");
  if (url.port !== "" && url.port !== "443") forbid("Hanya port 443 yang diperbolehkan", { port: url.port });
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && !isPublicIp(host)) forbid("Alamat bukan IP publik", { host });
  const resolver = options.resolver ?? systemResolver;
  let addresses: string[];
  if (isIP(host) !== 0) addresses = [host];
  else {
    try {
      addresses = await resolver(host);
    } catch {
      return { reachable: false, reason: "dns" };
    }
  }
  if (addresses.length === 0) return { reachable: false, reason: "dns" };
  // one private answer among public ones is enough to refuse: the connection could be sent there
  const bad = addresses.find((a) => !isPublicIp(a));
  if (bad !== undefined) forbid("Nama diresolve ke alamat yang bukan IP publik", { host });
  const transport = options.transport ?? httpsTransport(resolver, () => forbid("Alamat berubah menjadi bukan IP publik saat koneksi", { host }));
  let res: { status: number; body: Buffer; truncated: boolean };
  const total = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    res = await Promise.race([
      transport({ host, address: addresses[0] as string, path: `${url.pathname}${url.search}`, timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS, method: options.method ?? "GET", maxBytes: options.maxBytes ?? MAX_BODY_BYTES, ...(options.onChunk ? { onChunk: options.onChunk } : {}) }),
      // the deadline of the whole request, whatever the transport does
      new Promise<never>((_r, rej) => {
        timer = setTimeout(() => rej(new Error("timeout")), total);
      }),
    ]);
    clearTimeout(timer);
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.message === "timeout") return forbid("Batas waktu 5 detik terlewati", { host });
    return { reachable: false, reason: "connect" };
  }
  if (res.status >= 300 && res.status < 400) forbid("Redirect tidak diikuti", { status: res.status });
  const cap = options.maxBytes ?? MAX_BODY_BYTES;
  if (res.truncated || res.body.length > cap) forbid(`Isi lebih dari ${cap} byte`, { host });
  return { reachable: true, status: res.status, body: res.body.toString("utf8"), bytes: res.body };
}
