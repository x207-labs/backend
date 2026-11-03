import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, DEFAULT_OPEN } from "../../src/api/abuse.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (n === "node_modules" || n === "dist" ? [] : statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : n.endsWith(".ts") ? [join(dir, n)] : []));

/** Every variable of the project that the code of the backend and the broker names: the families of the project, as they are written in the sources. */
const FAMILY = /\b((?:API|BROKER|X207|NEAR_RPC|ONECLICK|METRICS)_[A-Z0-9_]+)\b/g;
function inCode(): Set<string> {
  const names = new Set<string>();
  for (const file of [...walk(join(ROOT, "src")), ...walk(join(ROOT, "broker/src"))]) for (const m of readFileSync(file, "utf8").matchAll(FAMILY)) names.add(m[1] as string);
  return names;
}

interface Row { name: string; process: string; required: string; secret: string; what: string }
function table(): Row[] {
  const text = readFileSync(join(ROOT, "docs/operations.md"), "utf8");
  const section = text.slice(text.indexOf("## Environment variables"), text.indexOf("## Start order"));
  return [...section.matchAll(/^\| `([A-Z0-9_]+)` \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)].map((m) => ({ name: m[1]!, process: m[2]!.trim(), required: m[3]!.trim(), secret: m[4]!.trim(), what: m[5]!.trim() }));
}

describe("BE-073 the table of environment variables in docs/operations.md is the one the code reads", () => {
  it("TC-BE-073-10 every variable the code of the backend and the broker names is in the table, and every variable of the table is in the code", () => {
    const code = inCode();
    const documented = new Set(table().map((r) => r.name));
    expect([...code].filter((n) => !documented.has(n)).sort(), "in the code, not in docs/operations.md").toEqual([]);
    expect([...documented].filter((n) => !code.has(n)).sort(), "in docs/operations.md, not in the code").toEqual([]);
    expect(table().length).toBe(documented.size); // no name twice
  });

  it("TC-BE-073-11 each row says who reads it, whether it is required or its default, and whether it is a secret; the defaults of the limits are the ones of the code", () => {
    const rows = table();
    for (const r of rows) {
      expect(["backend", "broker", "both"], r.name).toContain(r.process);
      expect(r.required, r.name).toMatch(/^(required|default |none)/);
      expect(["yes", "no", "maybe"], r.name).toContain(r.secret);
      expect(r.what.length, r.name).toBeGreaterThan(5);
    }
    const byName = new Map(rows.map((r) => [r.name, r]));
    const numeric: Array<[string, number]> = [
      ["API_RATE_LIMIT_PER_MINUTE", DEFAULT_LIMITS.ipPerMinute], ["API_WRITE_RATE_PER_MINUTE_IP", DEFAULT_LIMITS.writeIpPerMinute], ["API_WRITE_RATE_PER_MINUTE_ACCOUNT", DEFAULT_LIMITS.writeAccountPerMinute],
      ["API_MAX_BODY_BYTES", DEFAULT_LIMITS.maxBodyBytes], ["API_MAX_PAGE_LIMIT", DEFAULT_LIMITS.maxPageLimit], ["API_MAX_OPEN_ORDERS", DEFAULT_OPEN.orders], ["API_MAX_OPEN_INVOICES", DEFAULT_OPEN.invoices], ["API_MAX_OPEN_PURCHASES", DEFAULT_OPEN.purchases],
      ["BROKER_ACCESS_RATE_PER_MINUTE_IP", 120], ["BROKER_ACCESS_RATE_PER_MINUTE_GRANT", 60], ["BROKER_MAX_BODY_BYTES", 16384], ["X207_API_PORT", 8080], ["X207_JOB_POLL_MS", 15000], ["BROKER_PORT", 8090], ["BROKER_POLL_SECONDS", 15],
    ];
    for (const [name, value] of numeric) expect(byName.get(name)!.required, name).toContain(`\`${value}\``);
  });

  it("TC-BE-073-12 a variable marked as a secret has no value in any .env.example, and the secrets that the code reads are marked", () => {
    const secrets = table().filter((r) => r.secret === "yes").map((r) => r.name);
    expect(secrets).toEqual(expect.arrayContaining(["X207_CODE_SEEN_KEY", "METRICS_TOKEN", "BROKER_PRIVATE_KEY", "BROKER_LEASE_PRIVATE_KEY", "ONECLICK_JWT"]));
    for (const file of [".env.example", "broker/.env.example"]) {
      const lines = readFileSync(join(ROOT, file), "utf8").split("\n").filter((l) => /^[A-Z0-9_]+=/.test(l));
      for (const l of lines) {
        const [name, ...rest] = l.split("=");
        if (secrets.includes(name!)) expect(rest.join("=").trim(), `${file} ${name}`).toBe("");
      }
    }
  });

  it("TC-BE-073-13 the runbook has the parts that were asked for: start order, backup and restore with the commands, the rotations, the upgrade, systemd units and a Procfile", () => {
    const text = readFileSync(join(ROOT, "docs/operations.md"), "utf8");
    for (const heading of ["## Environment variables", "## Start order", "## Backup and restore", "## Rotation of secrets", "## Upgrade with migrations", "## Examples"]) expect(text, heading).toContain(heading);
    for (const needle of ["db-backup.mjs backup", "db-backup.mjs restore", "db-backup.mjs check", "X207_CODE_SEEN_KEY", "METRICS_TOKEN", "SIGHUP", "[Service]", "Procfile", "ExecStart=", "code_duplicate"]) expect(text, needle).toContain(needle);
    // the commands of the runbook name scripts that exist
    for (const script of ["scripts/db-backup.mjs"]) expect(() => statSync(join(ROOT, script))).not.toThrow();
  });
});
