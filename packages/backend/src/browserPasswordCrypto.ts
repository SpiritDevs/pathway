/** Server encryption for account-owned website passwords, separate from company credentials. */
import {
  integrationCredentialKeyringFromEnv,
  type IntegrationCredentialCiphertext,
  type IntegrationCredentialKeyring,
} from "./integrationCredentials.ts";

export interface BrowserPasswordIdentity {
  readonly userId: string;
  readonly credentialId: string;
  readonly origin: string;
}

export function browserPasswordKeyringFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): IntegrationCredentialKeyring {
  try {
    return integrationCredentialKeyringFromEnv({
      PATHWAY_INTEGRATION_CREDENTIAL_ACTIVE_KEY_ID: env.PATHWAY_BROWSER_PASSWORD_ACTIVE_KEY_ID,
      PATHWAY_INTEGRATION_CREDENTIAL_KEYS: env.PATHWAY_BROWSER_PASSWORD_KEYS,
    });
  } catch {
    throw new Error(
      "Password vault encryption is not configured. Configure PATHWAY_BROWSER_PASSWORD_ACTIVE_KEY_ID and PATHWAY_BROWSER_PASSWORD_KEYS.",
    );
  }
}

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
const aad = (identity: BrowserPasswordIdentity) =>
  new TextEncoder().encode(
    JSON.stringify({
      purpose: "pathway-browser-password-v1",
      userId: identity.userId,
      credentialId: identity.credentialId,
      origin: identity.origin,
    }),
  );

export function normalizeBrowserPasswordOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
      throw new Error();
    return url.origin;
  } catch {
    throw new Error("Enter a valid HTTP or HTTPS website address without credentials.");
  }
}

export async function encryptBrowserPassword(
  password: string,
  identity: BrowserPasswordIdentity,
  keyring: IntegrationCredentialKeyring,
): Promise<IntegrationCredentialCiphertext> {
  const bytes = keyring.keys.get(keyring.activeKeyId);
  if (!bytes) throw new Error("The password vault encryption key is unavailable.");
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(bytes).buffer,
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad(identity), tagLength: 128 },
      key,
      new TextEncoder().encode(password),
    ),
  );
  return {
    keyId: keyring.activeKeyId,
    iv: encode(iv),
    ciphertext: encode(encrypted.slice(0, -16)),
    authenticationTag: encode(encrypted.slice(-16)),
  };
}

export async function decryptBrowserPassword(
  sealed: IntegrationCredentialCiphertext,
  identity: BrowserPasswordIdentity,
  keyring: IntegrationCredentialKeyring,
): Promise<string> {
  try {
    const bytes = keyring.keys.get(sealed.keyId);
    if (!bytes) throw new Error();
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(bytes).buffer,
      "AES-GCM",
      false,
      ["decrypt"],
    );
    const encrypted = new Uint8Array([
      ...decode(sealed.ciphertext),
      ...decode(sealed.authenticationTag),
    ]);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(sealed.iv), additionalData: aad(identity), tagLength: 128 },
      key,
      encrypted,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("This password could not be unlocked.");
  }
}
