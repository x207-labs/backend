// (Copy of backend/src/log.ts: the broker is a separate package.) Structured logs (BE-071): one JSON object per line, with the secrets taken out before the line is written. Two layers, because a secret can arrive under a name or without one:
//   1. a field whose NAME says it is a secret (key, token, secret, signature, password, authorization, cookie, seed, private, …) is replaced whole, whatever its value;
//   2. every string, in any field and in the message, has the SHAPES of secrets replaced: `ed25519:…` keys and signatures, `Bearer …`, `sk-…`, GitHub and JWT tokens, `token=…` in a URL.
// Public keys (`pubkey…`, `public_key`) are not secret and are kept. The redaction is a net, not a licence: do not put a secret in a log call.
export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACTED = "[redacted]";

const SECRET_NAME = /(key|token|secret|signature|password|passphrase|authorization|cookie|seed|mnemonic|private|jwt|credential)/i;
const PUBLIC_NAME = /(pubkey|public_?key|publickey|voucher_?key_?fingerprint|fingerprint)/i;
const SHAPES: Array<[RegExp, string]> = [
  [/ed25519:[1-9A-HJ-NP-Za-km-z]{16,}/g, "ed25519:[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, REDACTED],
  [/\b(api[_-]?key|access[_-]?token|token|secret|password|signature)=([^&\s"']+)/gi, "$1=[redacted]"],
];

export function redactString(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SHAPES) out = out.replace(pattern, replacement);
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return value;
  if (depth > 6) return "[too deep]";
  if (value instanceof Error) return { name: value.name, message: redactString(value.message), ...(value.stack ? { stack: redactString(value.stack) } : {}) };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const isPublic = PUBLIC_NAME.test(k);
    // a public key (`pubkey_voucher`) is not a secret: kept as it is, though its text has the shape of a key
    out[k] = SECRET_NAME.test(k) && !isPublic ? REDACTED : isPublic && typeof v === "string" && /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(v) ? v : redact(v, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(options: { write?: (line: string) => void; now?: () => number; level?: LogLevel; base?: Record<string, unknown> } = {}): Logger {
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = options.now ?? Date.now;
  const min = ORDER[options.level ?? "info"];
  const emit = (level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void => {
    if (ORDER[level] < min) return;
    const base = redact(options.base ?? {}) as Record<string, unknown>;
    const body = redact(fields) as Record<string, unknown>;
    // ts, level and msg come last so that a field cannot overwrite them
    write(JSON.stringify({ ...base, ...body, ts: new Date(now()).toISOString(), level, msg: redactString(msg) }));
  };
  return { debug: (m, f) => emit("debug", m, f), info: (m, f) => emit("info", m, f), warn: (m, f) => emit("warn", m, f), error: (m, f) => emit("error", m, f) };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** The writer of the broker: a line of text from the code becomes one JSON object with the secrets taken out. */
export const jsonLine = (write: (line: string) => void = (l) => process.stderr.write(`${l}\n`), now: () => number = Date.now) => (text: string): void =>
  write(JSON.stringify({ ts: new Date(now()).toISOString(), level: "info", msg: redactString(text) }));
