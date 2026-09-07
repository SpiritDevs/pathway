import {
  allParts,
  decodeText,
  GmailContentTooLarge,
  messageMetadata,
  type GmailMessage,
  type makeGmail,
} from "./gmail.ts";
import { decodeBase64Url, hashToken } from "./crypto.ts";

export interface PrivateMailStorage {
  put(
    name: string,
    mimeType: string,
    bytes: Uint8Array<ArrayBuffer>,
    customId?: string,
  ): Promise<string>;
  signedUrl(key: string): Promise<string>;
  delete(keys: string[]): Promise<void>;
}
export function makePrivateMailStorage(
  apiKey: string,
  fetcher: typeof fetch = fetch,
  onPrepared: (key: string) => Promise<void> = async () => {},
): PrivateMailStorage {
  const api = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetcher(`https://api.uploadthing.com/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-uploadthing-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) throw new Error(`Mail storage request failed (${response.status})`);
    return (await response.json()) as T;
  };
  return {
    async put(name, mimeType, bytes, customId) {
      const prepared = await api<{ key: string; url: string }>("v7/prepareUpload", {
        fileName: name.slice(0, 250),
        fileSize: bytes.byteLength,
        fileType: mimeType,
        acl: "private",
        contentDisposition: "attachment",
        expiresIn: 300,
        ...(customId ? { customId } : {}),
      });
      await onPrepared(prepared.key);
      const url = new URL(prepared.url);
      if (url.protocol !== "https:" || !url.hostname.endsWith(".ingest.uploadthing.com"))
        throw new Error("Unexpected mail storage upload host");
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: mimeType }), name);
      const response = await fetcher(url, {
        method: "PUT",
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`Mail storage upload failed (${response.status})`);
      return prepared.key;
    },
    async signedUrl(key) {
      const result = await api<{ ufsUrl: string }>("v6/requestFileAccess", {
        fileKey: key,
        expiresIn: 60,
      });
      if (typeof result.ufsUrl !== "string" || !result.ufsUrl.startsWith("https://"))
        throw new Error("Invalid mail download URL");
      return result.ufsUrl;
    },
    async delete(keys) {
      if (keys.length) await api("v6/deleteFiles", { fileKeys: keys });
    },
  };
}
export async function materializeMessage(
  message: GmailMessage,
  gmail: ReturnType<typeof makeGmail>,
  storage: PrivateMailStorage,
  renew: () => Promise<void> = async () => {},
  accountId = "",
) {
  if (message.contentOmitted)
    return {
      bodyTruncated: true,
      ...messageMetadata(message),
      snippet: "Large message content remains in Gmail. " + (message.snippet ?? "").slice(0, 1800),
      textBody:
        "This message exceeds Pathway's download limit. Open it in Gmail to read the complete message and attachments.",
      attachments: [],
    };
  const parts = message.payload ? allParts(message.payload) : [];
  let contentIncomplete = false;
  let textBody = "",
    htmlBody = "";
  const attachments: Array<{
    partId: string;
    filename: string;
    mimeType: string;
    size: number;
    blobKey?: string;
  }> = [];
  const allocated: string[] = [];
  const put = async (
    partId: string,
    name: string,
    mimeType: string,
    bytes: Uint8Array<ArrayBuffer>,
  ) => {
    await renew();
    return storage.put(
      name,
      mimeType,
      bytes,
      await hashToken(`${accountId}:${message.id}:${partId}`),
    );
  };
  try {
    for (const part of parts) {
      await renew();
      if (part.parts?.length) continue;
      const isAttachment =
        Boolean(part.filename) || !["text/plain", "text/html"].includes(part.mimeType ?? "");
      if (!part.body?.data && !part.body?.attachmentId) continue;
      if ((part.body.size ?? 0) > 5 * 1024 * 1024 || attachments.length >= 40) {
        contentIncomplete = true;
        attachments.push({
          partId: part.partId ?? String(attachments.length),
          filename: `${part.filename || "attachment"} (open in Gmail: download limit)`,
          mimeType: part.mimeType || "application/octet-stream",
          size: part.body.size ?? 0,
        });
        continue;
      }
      const data = part.body.attachmentId
        ? (await gmail.attachment(message.id, part.body.attachmentId)).data
        : part.body.data!;
      if (isAttachment) {
        const blobKey = await put(
          `part:${part.partId ?? attachments.length}`,
          part.filename || "attachment",
          part.mimeType || "application/octet-stream",
          decodeBase64Url(data),
        );
        allocated.push(blobKey);
        attachments.push({
          partId: part.partId ?? String(attachments.length),
          filename: part.filename || "attachment",
          mimeType: part.mimeType || "application/octet-stream",
          size: part.body.size ?? 0,
          blobKey,
        });
      } else if (part.mimeType === "text/plain")
        textBody += decodeText(
          data,
          part.headers?.find((h) => h.name.toLowerCase() === "content-type")?.value,
        );
      else
        htmlBody += decodeText(
          data,
          part.headers?.find((h) => h.name.toLowerCase() === "content-type")?.value,
        );
    }
    await renew();
    let rawBlobKey: string | undefined;
    if ((message.sizeEstimate ?? 0) <= 5 * 1024 * 1024) {
      try {
        const raw = await gmail.raw(message.id);
        if (!raw.raw) throw new Error("Gmail returned no raw message");
        rawBlobKey = await put(
          "raw",
          `${message.id}.eml`,
          "message/rfc822",
          decodeBase64Url(raw.raw),
        );
        allocated.push(rawBlobKey);
      } catch (error) {
        if (!(error instanceof GmailContentTooLarge)) throw error;
      }
    }
    let bodyBlobKey: string | undefined;
    if (new TextEncoder().encode(textBody + htmlBody).byteLength > 96_000) {
      bodyBlobKey = await put(
        "body",
        `${message.id}-body.json`,
        "application/json",
        new TextEncoder().encode(JSON.stringify({ textBody, htmlBody })),
      );
      allocated.push(bodyBlobKey);
      textBody = textBody.slice(0, 16_000);
      htmlBody = "";
    }
    await renew();
    return {
      ...messageMetadata(message),
      textBody,
      htmlBody,
      ...(rawBlobKey ? { rawBlobKey } : {}),
      ...(bodyBlobKey ? { bodyBlobKey } : {}),
      ...(bodyBlobKey || contentIncomplete ? { bodyTruncated: true } : {}),
      attachments,
    };
  } catch (error) {
    await storage.delete(allocated).catch(() => {});
    throw error;
  }
}
