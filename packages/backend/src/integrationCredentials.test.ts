import { describe, expect, it } from "vite-plus/test";

import {
  decryptIntegrationCredential,
  encryptIntegrationCredential,
  integrationCredentialKeyringFromEnv,
  type IntegrationCredentialKeyring,
} from "./integrationCredentials.ts";

const key = (fill: number) => new Uint8Array(32).fill(fill);
const keyring = (activeKeyId = "v1"): IntegrationCredentialKeyring => ({
  activeKeyId,
  keys: new Map([
    ["v1", key(1)],
    ["v2", key(2)],
  ]),
});
const aad = { companyId: "company-1", integrationId: "integration-1", workspaceId: "T1" };

describe("integration credential encryption", () => {
  it("round-trips without storing plaintext and uses a fresh IV", async () => {
    const first = await encryptIntegrationCredential("xoxb-secret", aad, keyring());
    const second = await encryptIntegrationCredential("xoxb-secret", aad, keyring());
    expect(first.ciphertext).not.toContain("xoxb-secret");
    expect(first.iv).not.toBe(second.iv);
    await expect(decryptIntegrationCredential(first, aad, keyring())).resolves.toBe("xoxb-secret");
  });

  it("fails closed for an AAD mismatch, missing key, or modified tag", async () => {
    const sealed = await encryptIntegrationCredential("xoxb-secret", aad, keyring());
    await expect(
      decryptIntegrationCredential(sealed, { ...aad, workspaceId: "T2" }, keyring()),
    ).rejects.toThrow("could not be decrypted");
    await expect(
      decryptIntegrationCredential(sealed, aad, {
        activeKeyId: "v2",
        keys: new Map([["v2", key(2)]]),
      }),
    ).rejects.toThrow("key is unavailable");
    await expect(
      decryptIntegrationCredential(
        {
          ...sealed,
          authenticationTag: `${sealed.authenticationTag.startsWith("A") ? "B" : "A"}${sealed.authenticationTag.slice(1)}`,
        },
        aad,
        keyring(),
      ),
    ).rejects.toThrow("could not be decrypted");
  });

  it("parses a versioned operator keyring and requires a 256-bit active key", () => {
    const encoded = btoa(String.fromCharCode(...key(7)));
    expect(
      integrationCredentialKeyringFromEnv({
        PATHWAY_INTEGRATION_CREDENTIAL_ACTIVE_KEY_ID: "v7",
        PATHWAY_INTEGRATION_CREDENTIAL_KEYS: JSON.stringify({ v7: encoded }),
      }).keys.get("v7"),
    ).toHaveLength(32);
    expect(() =>
      integrationCredentialKeyringFromEnv({
        PATHWAY_INTEGRATION_CREDENTIAL_ACTIVE_KEY_ID: "missing",
        PATHWAY_INTEGRATION_CREDENTIAL_KEYS: JSON.stringify({ v7: encoded }),
      }),
    ).toThrow("active integration credential key");
  });
});
