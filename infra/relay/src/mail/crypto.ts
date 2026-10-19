/** Envelope encryption keeps per-record data keys replaceable independently of the relay KEK. */
export const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};
export const decodeBase64Url = (value: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
export const randomToken = () => encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
export const hashToken = async (value: string) =>
  encodeBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
  );

export function makeEnvelopeCipher(masterKey: string) {
  const raw = decodeBase64Url(masterKey);
  if (raw.length !== 32) throw new Error("MAIL_ENCRYPTION_KEY must encode 32 random bytes");
  const kek = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  const aad = (context: string) => new TextEncoder().encode(`pathway-mail:v1:${context}`);
  return {
    async seal(value: unknown, context: string): Promise<string> {
      const dataKey = crypto.getRandomValues(new Uint8Array(32));
      const key = await crypto.subtle.importKey("raw", dataKey, "AES-GCM", false, ["encrypt"]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const wrapIv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad(context) },
        key,
        new TextEncoder().encode(JSON.stringify(value)),
      );
      const wrapped = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: wrapIv, additionalData: aad(context) },
        await kek,
        dataKey,
      );
      return JSON.stringify({
        v: 1,
        iv: encodeBase64Url(iv),
        wrapIv: encodeBase64Url(wrapIv),
        key: encodeBase64Url(new Uint8Array(wrapped)),
        data: encodeBase64Url(new Uint8Array(encrypted)),
      });
    },
    async open<T>(envelope: string, context: string): Promise<T> {
      const value = JSON.parse(envelope) as {
        v: number;
        iv: string;
        wrapIv: string;
        key: string;
        data: string;
      };
      if (value.v !== 1) throw new Error("Unsupported mail credential envelope");
      const rawKey = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: decodeBase64Url(value.wrapIv), additionalData: aad(context) },
        await kek,
        decodeBase64Url(value.key),
      );
      const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
      const clear = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: decodeBase64Url(value.iv), additionalData: aad(context) },
        key,
        decodeBase64Url(value.data),
      );
      return JSON.parse(new TextDecoder().decode(clear)) as T;
    },
  };
}

export async function oauthBrowserCookie(state: string) {
  const digest = await hashToken(state);
  return { name: `__Host-pathway-mail-${digest.slice(0, 16)}`, value: digest };
}
export async function hasOAuthBrowserCookie(state: string, header: string | null) {
  const { name, value } = await oauthBrowserCookie(state);
  return (header ?? "").split(";").some((cookie) => cookie.trim() === `${name}=${value}`);
}
