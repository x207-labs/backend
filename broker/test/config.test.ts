import { describe, expect, it } from "vitest";
import { ConfigError, readConfig } from "../src/config.js";

const env = {
  X207_READ_API_URL: "http://api", X207_CONTRACT_ID: "c.near", X207_FACILITATOR_URL: "http://f", NEAR_RPC_URL: "http://rpc",
  BROKER_ACCOUNT_ID: "b.near", BROKER_PRIVATE_KEY: "ed25519:SECRETSECRET", BROKER_LEASE_ACCOUNT_ID: "l.near", BROKER_LEASE_PRIVATE_KEY: "ed25519:OTHERSECRET",
};

describe("broker config", () => {
  it("reads the variables and applies the defaults", () => {
    expect(readConfig(env)).toMatchObject({ circleId: "agents-main", port: 8090, dbPath: "./broker.db", pollSeconds: 15, leaseAccount: "l.near" });
  });

  it("BE-066 fix: the limits of the access routes have defaults; API_LIMITS=off (or BROKER_LIMITS=off) turns the rates off and keeps the body cap; a wrong value is named", () => {
    expect(readConfig(env).accessLimits).toEqual({ ipPerMinute: 120, grantPerMinute: 60, maxBodyBytes: 16384 });
    expect(readConfig({ ...env, API_LIMITS: "off" }).accessLimits).toEqual({ ipPerMinute: 0, grantPerMinute: 0, maxBodyBytes: 16384 });
    expect(readConfig({ ...env, BROKER_LIMITS: "off", BROKER_MAX_BODY_BYTES: "2048" }).accessLimits).toEqual({ ipPerMinute: 0, grantPerMinute: 0, maxBodyBytes: 2048 });
    expect(readConfig({ ...env, BROKER_LIMITS: "on", API_LIMITS: "off" }).accessLimits.ipPerMinute).toBe(120); // the variable of the broker wins
    expect(() => readConfig({ ...env, API_LIMITS: "maybe" })).toThrow(/LIMITS/);
  });

  it("a missing or malformed variable is named, and a key never appears in the message", () => {
    expect(() => readConfig({ ...env, BROKER_ACCOUNT_ID: "" })).toThrow(/BROKER_ACCOUNT_ID/);
    let message = "";
    try {
      readConfig({ ...env, BROKER_PRIVATE_KEY: "SECRETWITHOUTPREFIX" });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      message = (error as Error).message;
    }
    expect(message).toMatch(/BROKER_PRIVATE_KEY/);
    expect(message).not.toMatch(/SECRETWITHOUTPREFIX/);
    expect(() => readConfig({ ...env, BROKER_PORT: "x" })).toThrow(/BROKER_PORT/);
  });
});
