import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import schema from "../convex/schema.ts";
import { decryptBrowserPassword, encryptBrowserPassword } from "./browserPasswordCrypto.ts";

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/browserPasswords.ts": () => import("../convex/browserPasswords.ts"),
};
const save = makeFunctionReference<"action">("browserPasswords:save");
const list = makeFunctionReference<"query">("browserPasswords:list");
const autofill = makeFunctionReference<"action">("browserPasswords:getForAutofill");
const remove = makeFunctionReference<"mutation">("browserPasswords:remove");
const login = {
  id: "credential-1",
  label: "Work",
  origin: "https://example.com/login",
  username: "corey",
  password: "test-secret",
};
const keyring = { activeKeyId: "v1", keys: new Map([["v1", new Uint8Array(32).fill(7)]]) };

async function harness() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    for (const subject of ["user-a", "user-b"])
      await ctx.db.insert("users", {
        clerkSubject: subject,
        email: `${subject}@example.test`,
        displayName: subject,
        imageUrl: null,
        createdAt: 1,
        updatedAt: 1,
      });
  });
  return {
    t,
    owner: t.withIdentity({ subject: "user-a", issuer: "https://clerk.example.test" }),
    other: t.withIdentity({ subject: "user-b", issuer: "https://clerk.example.test" }),
  };
}

describe("personal password vault", () => {
  beforeEach(() => {
    vi.stubEnv("PATHWAY_BROWSER_PASSWORD_ACTIVE_KEY_ID", "v1");
    vi.stubEnv(
      "PATHWAY_BROWSER_PASSWORD_KEYS",
      JSON.stringify({ v1: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) }),
    );
    vi.stubEnv("PATHWAY_RELAY_JWT_ISSUER", "https://relay.example.test");
    vi.stubEnv("PATHWAY_RELAY_JWKS_URL", "https://relay.example.test/.well-known/jwks.json");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("stores ciphertext and lists metadata, only unlocking for the owner and exact origin", async () => {
    const { t, owner, other } = await harness();
    await owner.action(save, login);
    const rows = await owner.query(list, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: login.id,
      origin: "https://example.com",
      username: "corey",
      revision: 1,
    });
    expect(rows[0]).not.toHaveProperty("ciphertext");
    expect(rows[0]).not.toHaveProperty("password");
    const stored = await t.run((ctx) => ctx.db.query("browserPasswords").collect());
    expect(JSON.stringify(stored)).not.toContain(login.password);
    await expect(
      owner.action(autofill, { id: login.id, origin: "https://example.com/account" }),
    ).resolves.toMatchObject({ password: login.password });
    await expect(
      owner.action(autofill, { id: login.id, origin: "https://other.example" }),
    ).rejects.toThrow("different website");
    expect(await other.query(list, {})).toEqual([]);
    await expect(other.action(autofill, { id: login.id, origin: login.origin })).rejects.toThrow(
      "unavailable",
    );
    await expect(other.mutation(remove, { id: login.id, expectedRevision: 1 })).rejects.toThrow(
      "unavailable",
    );
    await expect(t.query(list, {})).rejects.toThrow();
    const environment = t.withIdentity({ subject: "user-a", issuer: "https://relay.example.test" });
    await expect(
      environment.action(autofill, { id: login.id, origin: login.origin }),
    ).rejects.toThrow();
  });

  it("requires current revisions and allows the owner to remove a login", async () => {
    const { owner } = await harness();
    await owner.action(save, login);
    await owner.action(save, { ...login, expectedRevision: 1, password: "changed" });
    await expect(owner.action(save, { ...login, expectedRevision: 1 })).rejects.toThrow(
      "changed on another device",
    );
    await expect(owner.mutation(remove, { id: login.id, expectedRevision: 1 })).rejects.toThrow(
      "changed on another device",
    );
    await owner.mutation(remove, { id: login.id, expectedRevision: 2 });
    expect(await owner.query(list, {})).toEqual([]);
  });

  it("fails closed without deployment encryption keys and rejects invalid websites", async () => {
    const { t, owner } = await harness();
    vi.stubEnv("PATHWAY_BROWSER_PASSWORD_KEYS", "");
    await expect(owner.action(save, login)).rejects.toThrow("not configured");
    expect(await t.run((ctx) => ctx.db.query("browserPasswords").collect())).toEqual([]);
    await expect(owner.action(save, { ...login, origin: "javascript:alert(1)" })).rejects.toThrow(
      "website address",
    );
  });

  it("binds encrypted values to account, credential, website, and a fresh IV", async () => {
    const identity = {
      userId: "user-a",
      credentialId: "credential",
      origin: "https://example.com",
    };
    const first = await encryptBrowserPassword("secret", identity, keyring);
    const second = await encryptBrowserPassword("secret", identity, keyring);
    expect(first.iv).not.toEqual(second.iv);
    await expect(decryptBrowserPassword(first, identity, keyring)).resolves.toBe("secret");
    for (const mismatch of [
      { userId: "user-b" },
      { credentialId: "another" },
      { origin: "https://other.example" },
    ]) {
      await expect(
        decryptBrowserPassword(first, { ...identity, ...mismatch }, keyring),
      ).rejects.toThrow("could not be unlocked");
    }
    await expect(
      decryptBrowserPassword({ ...first, authenticationTag: "AAAA" }, identity, keyring),
    ).rejects.toThrow("could not be unlocked");
  });
});
