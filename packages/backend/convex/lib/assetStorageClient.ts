/** Private-only UploadThing REST adapter. Never return its signed read URL to a client. */
export function storageApiKey() {
  const token = process.env.UPLOADTHING_TOKEN?.trim();
  if (!token) throw new Error("UploadThing is not configured.");
  if (token.startsWith("sk_")) return token;
  try {
    const parsed: unknown = JSON.parse(atob(token));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "apiKey" in parsed &&
      typeof parsed.apiKey === "string"
    )
      return parsed.apiKey;
  } catch {
    /* fail closed below */
  }
  throw new Error("UploadThing token is invalid.");
}
export async function storageRequest(
  path: string,
  body: unknown,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const response = await fetcher(`https://api.uploadthing.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-uploadthing-api-key": storageApiKey(),
      "x-uploadthing-version": "7.7.4",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Private storage request failed (${response.status}).`);
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null) throw new Error("Invalid storage response.");
  return value as Record<string, unknown>;
}
export async function signedStorageUrl(key: string, fetcher: typeof fetch = fetch) {
  const result = await storageRequest(
    "/v6/requestFileAccess",
    { fileKey: key, expiresIn: 60 },
    fetcher,
  );
  const url = result.ufsUrl ?? result.url;
  if (typeof url !== "string" || !url.startsWith("https://"))
    throw new Error("No private storage URL.");
  return url;
}
export function previewable(bytes: Uint8Array) {
  const ascii = (start: number, length: number) =>
    new TextDecoder().decode(bytes.slice(start, start + length));
  return (
    (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    ascii(1, 3) === "PNG" ||
    ascii(0, 6) === "GIF89a" ||
    ascii(0, 6) === "GIF87a" ||
    (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") ||
    ascii(0, 3) === "ID3" ||
    ascii(0, 4) === "OggS"
  );
}
