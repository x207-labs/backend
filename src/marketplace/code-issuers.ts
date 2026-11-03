// Issuers of one-time codes (BE-069, ADR-48). An adapter answers one question about a plain code: is it still good (`valid`), already spent (`used`), or not known to the issuer (`unknown`)?
// `CodeIssuer` is the interface of the SDK (SD-076); the backend only calls it, once, when the seller shows the code for the check before the key is released. The real issuers are written by
// the operator and registered at start (`marketplaceRoutes(db, { codeIssuers: { name: adapter } })`); the mock below is for tests and for the demo.
import type { CodeCheck, CodeIssuer } from "@x207/core";

export type { CodeCheck, CodeIssuer };

/** An issuer that keeps a set of codes in memory: `issue` makes one good, `markUsed` spends it. Not for money. */
export class MockCodeIssuer implements CodeIssuer {
  readonly #codes = new Map<string, "valid" | "used">();
  /** When `true`, `checkCode` throws (the issuer is down). */
  unavailable = false;
  /** How many times the issuer was asked (a test counts them). */
  calls = 0;

  issue(code: string): this {
    this.#codes.set(code, "valid");
    return this;
  }

  markUsed(code: string): this {
    this.#codes.set(code, "used");
    return this;
  }

  async checkCode(code: string): Promise<CodeCheck> {
    this.calls += 1;
    if (this.unavailable) throw new Error("issuer unavailable");
    return this.#codes.get(code) ?? "unknown";
  }
}
