import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

describe("BK-001 scaffold", () => {
  it("the four folders exist and the README names M10 and F8", () => {
    for (const folder of ["watcher", "keys", "proxy", "attest"]) expect(existsSync(new URL(`src/${folder}/index.ts`, root)), folder).toBe(true);
    const readme = readFileSync(new URL("README.md", root), "utf8");
    expect(readme).toMatch(/M10/);
    expect(readme).toMatch(/F8/);
    expect(readme).toMatch(/x207-labs\/x207/);
  });

  it(".env.example lists the variables without values for secrets", () => {
    const env = readFileSync(new URL(".env.example", root), "utf8");
    for (const name of ["BROKER_PRIVATE_KEY", "BROKER_LEASE_PRIVATE_KEY"]) expect(env).toMatch(new RegExp(`^${name}=$`, "m"));
  });
});
