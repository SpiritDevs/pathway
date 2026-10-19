/** Application-layer encryption for company integration credentials. */

export const INTEGRATION_CREDENTIAL_ACTIVE_KEY_ID_ENV =
  "PATHWAY_INTEGRATION_CREDENTIAL_ACTIVE_KEY_ID";
export const INTEGRATION_CREDENTIAL_KEYS_ENV = "PATHWAY_INTEGRATION_CREDENTIAL_KEYS";

export interface IntegrationCredentialCiphertext {
  readonly keyId: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly authenticationTag: string;
}

export interface IntegrationCredentialAad {
  readonly companyId: string;
  readonly integrationId: string;
  readonly workspaceId: string;
}

export interface IntegrationCredentialKeyring {
  readonly activeKeyId: string;
  readonly keys: ReadonlyMap<string, Uint8Array>;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function aadBytes(aad: IntegrationCredentialAad): Uint8Array {
  return textEncoder.encode(
    JSON.stringify({
      companyId: aad.companyId,
      integrationId: aad.integrationId,
      workspaceId: aad.workspaceId,
    }),
  );
}

function parseKeys(value: string): ReadonlyMap<string, Uint8Array> {
  let input: unknown;
  try {
    input = JSON.parse(value);
  } catch {
    throw new Error(`${INTEGRATION_CREDENTIAL_KEYS_ENV} must be a JSON object.`);
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${INTEGRATION_CREDENTIAL_KEYS_ENV} must be a JSON object.`);
  }
  const keys = new Map<string, Uint8Array>();
  for (const [keyId, encoded] of Object.entries(input)) {
    if (keyId.trim() !== keyId || keyId.length === 0 || typeof encoded !== "string") {
      throw new Error(`${INTEGRATION_CREDENTIAL_KEYS_ENV} contains an invalid key entry.`);
    }
    let key: Uint8Array;
    try {
      key = base64ToBytes(encoded);
    } catch {
      throw new Error(`${INTEGRATION_CREDENTIAL_KEYS_ENV} contains invalid base64.`);
    }
    if (key.byteLength !== 32) {
      throw new Error(`${INTEGRATION_CREDENTIAL_KEYS_ENV} keys must decode to 32 bytes.`);
    }
    keys.set(keyId, key);
  }
  return keys;
}

export function integrationCredentialKeyringFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): IntegrationCredentialKeyring {
  const activeKeyId = env[INTEGRATION_CREDENTIAL_ACTIVE_KEY_ID_ENV]?.trim();
  const encodedKeys = env[INTEGRATION_CREDENTIAL_KEYS_ENV];
  if (activeKeyId === undefined || activeKeyId.length === 0 || encodedKeys === undefined) {
    throw new Error("The integration credential keyring is not configured.");
  }
  const keys = parseKeys(encodedKeys);
  if (!keys.has(activeKeyId)) {
    throw new Error("The active integration credential key is not present in the keyring.");
  }
  return { activeKeyId, keys };
}

async function importAesKey(
  bytes: Uint8Array,
  usage: Array<"encrypt" | "decrypt">,
): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(bytes).buffer,
    { name: "AES-GCM" },
    false,
    usage,
  );
}

export async function encryptIntegrationCredential(
  plaintext: string,
  aad: IntegrationCredentialAad,
  keyring: IntegrationCredentialKeyring,
): Promise<IntegrationCredentialCiphertext> {
  const keyBytes = keyring.keys.get(keyring.activeKeyId);
  if (keyBytes === undefined) throw new Error("The active integration credential key is missing.");
  const key = await importAesKey(keyBytes, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: Uint8Array.from(iv).buffer,
        additionalData: Uint8Array.from(aadBytes(aad)).buffer,
        tagLength: 128,
      },
      key,
      textEncoder.encode(plaintext),
    ),
  );
  const tagOffset = sealed.byteLength - 16;
  return {
    keyId: keyring.activeKeyId,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(sealed.slice(0, tagOffset)),
    authenticationTag: bytesToBase64(sealed.slice(tagOffset)),
  };
}

export async function decryptIntegrationCredential(
  sealed: IntegrationCredentialCiphertext,
  aad: IntegrationCredentialAad,
  keyring: IntegrationCredentialKeyring,
): Promise<string> {
  const keyBytes = keyring.keys.get(sealed.keyId);
  if (keyBytes === undefined) throw new Error("The integration credential key is unavailable.");
  const ciphertext = base64ToBytes(sealed.ciphertext);
  const tag = base64ToBytes(sealed.authenticationTag);
  const combined = new Uint8Array(ciphertext.byteLength + tag.byteLength);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.byteLength);
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Uint8Array.from(base64ToBytes(sealed.iv)).buffer,
        additionalData: Uint8Array.from(aadBytes(aad)).buffer,
        tagLength: 128,
      },
      await importAesKey(keyBytes, ["decrypt"]),
      Uint8Array.from(combined).buffer,
    );
    return textDecoder.decode(plaintext);
  } catch {
    throw new Error("The integration credential could not be decrypted.");
  }
}
