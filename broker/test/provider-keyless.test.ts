import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ProviderAccessManager, S3PresignedAdapter, SshAdapter, parsePublicKey, presignUrl, s3AcceptsUrl, sshTimespec, sshdAccepts, type AuthorizedKeysFile, type ProviderGrantInput,
} from "../src/provider/index.js";
import { BrokerStore } from "../src/store.js";
import { NOW } from "./helpers.js";

const NS = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();
const DAY = 86_400_000;

/** A real ed25519 public key in the OpenSSH text form. */
function sshKey(): string {
  const der = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
  const raw = der.subarray(der.length - 32);
  const name = Buffer.from("ssh-ed25519");
  const blob = Buffer.concat([Buffer.from([0, 0, 0, name.length]), name, Buffer.from([0, 0, 0, 32]), raw]);
  return `ssh-ed25519 ${blob.toString("base64")}`;
}
const memoryFile = (): AuthorizedKeysFile & { text: string } => {
  const f = { text: "", read: async () => f.text, write: async (c: string) => void (f.text = c) };
  return f;
};
const grantInput = (provider: string, ref: string, resource: string | null, over: Record<string, unknown> = {}, id = 1): ProviderGrantInput => ({
  grant_id: id, limits: { scope: JSON.stringify({ provider, grantee_ref: ref, resource, ...over }), expires_at: NS(NOW + 10 * DAY) },
});

describe("BE-058 SSH adapter: authorized_keys with restrict, command= and expiry-time=", () => {
  const clock = { now: NOW };
  function setup() {
    clock.now = NOW;
    const file = memoryFile();
    const store = new BrokerStore(":memory:");
    const manager = new ProviderAccessManager({ store, now: () => clock.now });
    const ssh = new SshAdapter({ file, now: () => clock.now });
    (ssh as { needsChallenge: boolean }).needsChallenge = false;
    ssh.proveGranteeRef = async () => true; // these tests are about the line in authorized_keys; the proof has its own tests (provider-proof.test.ts)
    manager.register(ssh);
    return { file, manager, store };
  }

  it("TC-BE-058-01 the line has restrict, the forced command and the expiry; sshd lets the key in during the day and refuses it after, with the broker gone", async () => {
    const { file, manager, store } = setup();
    const key = sshKey();
    const { access } = await manager.grantAccess(grantInput("ssh", `${key} alice@laptop`, "/usr/local/bin/backup-read"));
    expect(access.nativeExpiresMs).toBe(NOW + DAY);
    expect(file.text).toBe(`restrict,command="/usr/local/bin/backup-read",expiry-time="${sshTimespec(NOW + DAY)}" ${key} x207-grant-1\n`);
    expect(sshdAccepts(file.text, key, NOW + DAY - 1000)).toEqual({ accepted: true, options: expect.stringContaining("restrict,command=") });
    // the broker is not called again: the line alone closes it
    expect(sshdAccepts(file.text, key, NOW + DAY).accepted).toBe(false);
    expect(sshdAccepts(file.text, key, NOW + 5 * DAY).accepted).toBe(false);
    store.close();
  });

  it("TC-BE-058-02 revoke removes only the line of the grant; the next day's rent replaces the line with a later expiry; other lines stay", async () => {
    const { file, manager, store } = setup();
    const a = sshKey();
    const b = sshKey();
    await manager.grantAccess(grantInput("ssh", a, "/bin/true", {}, 1));
    await manager.grantAccess(grantInput("ssh", b, "/bin/true", {}, 2));
    clock.now = NOW + DAY / 2;
    await manager.grantAccess(grantInput("ssh", a, "/bin/true", {}, 1));
    expect(file.text.split("\n").filter(Boolean)).toHaveLength(2);
    expect(file.text).toContain(`expiry-time="${sshTimespec(NOW + 2 * DAY)}" ${a} x207-grant-1`);
    await manager.revokeAccess(1, "defaulted");
    expect(file.text).toBe(`restrict,command="/bin/true",expiry-time="${sshTimespec(NOW + DAY)}" ${b} x207-grant-2\n`);
    expect(sshdAccepts(file.text, a, clock.now).accepted).toBe(false);
    expect(sshdAccepts(file.text, b, clock.now).accepted).toBe(true);
    await manager.revokeAccess(2, "x");
    expect(file.text).toBe("");
    store.close();
  });

  it("TC-BE-058-03 the reference must be a real public key, and no option can ride in it or in the command", async () => {
    const { manager, file, store } = setup();
    const good = sshKey();
    expect(parsePublicKey(good).ok).toBe(true);
    for (const bad of [
      `command="rm -rf /" ${good}`, "ssh-ed25519 AAAA", "ssh-dss AAAAB3NzaC1kc3M", `${good}\nssh-ed25519 AAAA`, "ssh-ed25519 !!!not-base64", `ssh-rsa ${good.split(" ")[1]}`, "",
    ]) {
      await expect(manager.grantAccess(grantInput("ssh", bad, "/bin/true")), bad).rejects.toMatchObject({ code: expect.stringMatching(/grantee_ref_unverified|scope_invalid/) });
    }
    for (const command of ['x" ,permitopen="*', "a\nb", "back\\slash", ""]) {
      await expect(manager.grantAccess(grantInput("ssh", good, command)), command).rejects.toMatchObject({ code: expect.stringMatching(/grant_failed|scope_invalid/) });
    }
    await expect(manager.grantAccess(grantInput("ssh", good, null))).rejects.toMatchObject({ code: "grant_failed" }); // no command: nothing opens
    expect(file.text).toBe("");
    store.close();
  });
});

describe("BE-058 presigned S3 URL: signed locally, refused by the store after its end", () => {
  const opts = { host: "examplebucket.s3.amazonaws.com", region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };

  it("TC-BE-058-04 the signature is the one of the AWS documentation for the same request", () => {
    const url = presignUrl(opts, { key: "test.txt", nowMs: Date.UTC(2013, 4, 24), expiresSeconds: 86400 });
    expect(url).toContain("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
    expect(url.startsWith("https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&")).toBe(true);
  });

  it("TC-BE-058-05 the URL works until its end and is refused after; a changed key, object or expiry breaks the signature", async () => {
    const clock = { now: NOW };
    const store = new BrokerStore(":memory:");
    const adapter = new S3PresignedAdapter({ ...opts, now: () => clock.now });
    const manager = new ProviderAccessManager({ store, now: () => clock.now });
    manager.register(adapter);
    const { access, delivery } = await manager.grantAccess(grantInput("s3-presigned", "carol", "datasets/report 2026.csv"));
    const url = String(delivery.url);
    expect(url).toContain("datasets/report%202026.csv");
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("86400");
    expect(access.nativeExpiresMs).toBe(NOW + DAY);
    expect(s3AcceptsUrl(opts, url, NOW + DAY - 1000)).toEqual({ accepted: true, reason: null });
    expect(s3AcceptsUrl(opts, url, NOW + DAY)).toEqual({ accepted: false, reason: "Request has expired" });
    expect(s3AcceptsUrl(opts, url, NOW + 3 * DAY).accepted).toBe(false);
    expect(s3AcceptsUrl(opts, url.replace("report%202026", "other"), NOW).reason).toBe("SignatureDoesNotMatch");
    expect(s3AcceptsUrl(opts, url.replace("X-Amz-Expires=86400", "X-Amz-Expires=604800"), NOW).reason).toBe("SignatureDoesNotMatch");
    expect(s3AcceptsUrl({ ...opts, secretAccessKey: "other" }, url, NOW).reason).toBe("SignatureDoesNotMatch");
    // the secret key is nowhere in what the lessee gets
    expect(JSON.stringify(delivery)).not.toContain(opts.secretAccessKey);
    expect(url).not.toContain(opts.secretAccessKey);
    // a revoke before the end only forgets the URL; it cannot take it back (the limit that is written down)
    await manager.revokeAccess(1, "defaulted");
    expect(s3AcceptsUrl(opts, url, NOW + 1000).accepted).toBe(true);
    store.close();
  });

  it("TC-BE-058-06 the end never passes the paid day or expires_at; a week is the largest; a grant without an object is refused", async () => {
    const store = new BrokerStore(":memory:");
    const manager = new ProviderAccessManager({ store, now: () => NOW });
    manager.register(new S3PresignedAdapter({ ...opts, now: () => NOW }));
    const short = { grant_id: 4, limits: { scope: JSON.stringify({ provider: "s3-presigned", grantee_ref: "carol", resource: "a.txt" }), expires_at: NS(NOW + 3600_000) } };
    const { delivery } = await manager.grantAccess(short);
    expect(new URL(String(delivery.url)).searchParams.get("X-Amz-Expires")).toBe("3600");
    await expect(manager.grantAccess(grantInput("s3-presigned", "carol", null, {}, 5))).rejects.toMatchObject({ code: "grant_failed" });
    await expect(manager.grantAccess(grantInput("s3-presigned", "bad ref", "a.txt", {}, 6))).rejects.toMatchObject({ code: "grantee_ref_unverified" });
    expect(() => presignUrl(opts, { key: "a", nowMs: NOW, expiresSeconds: 604_801 })).toThrow();
    expect(() => presignUrl(opts, { key: "/a", nowMs: NOW, expiresSeconds: 60 })).toThrow();
    store.close();
  });
});
