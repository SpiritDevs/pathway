import { decodeBase64Url, encodeBase64Url } from "./crypto.ts";

export class GmailError extends Error {
  readonly status: number;
  readonly operation: string;
  constructor(status: number, operation: string) {
    super(`Gmail ${operation} failed (${status})`);
    this.status = status;
    this.operation = operation;
  }
}
export class GmailContentTooLarge extends Error {}
const MAX_GMAIL_RESPONSE_BYTES = 8 * 1024 * 1024;
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_GMAIL_RESPONSE_BYTES) {
      await reader.cancel();
      throw new GmailContentTooLarge("Mail content exceeds the download limit");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId: string;
  historyId?: string;
  internalDate?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: GmailPart;
  raw?: string;
  sizeEstimate?: number;
  contentOmitted?: boolean;
}
export interface GmailHistory {
  historyId: string;
  nextPageToken?: string;
  history?: Array<{
    messagesAdded?: Array<{ message: { id: string } }>;
    messagesDeleted?: Array<{ message: { id: string } }>;
    labelsAdded?: Array<{ message: { id: string } }>;
    labelsRemoved?: Array<{ message: { id: string } }>;
  }>;
}
export interface Credentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  pubsubTopic?: string;
}
export function makeGmail(accessToken: string, fetcher: typeof fetch = fetch) {
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetcher(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
      ...init,
      signal: AbortSignal.timeout(25_000),
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        ...init?.headers,
      },
    });
    if (!response.ok) throw new GmailError(response.status, path.split("?")[0]!);
    return response.status === 204 ? (undefined as T) : ((await boundedJson(response)) as T);
  };
  return {
    profile: () => request<{ emailAddress: string; historyId: string }>("profile"),
    list: (pageToken?: string) =>
      request<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(
        `messages?maxResults=10&includeSpamTrash=false&q=newer_than%3A1y${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
      ),
    history: (cursor: string, pageToken?: string) =>
      request<GmailHistory>(
        `history?maxResults=5&startHistoryId=${encodeURIComponent(cursor)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
      ),
    message: async (id: string) => {
      try {
        return await request<GmailMessage>(`messages/${encodeURIComponent(id)}?format=full`);
      } catch (error) {
        if (!(error instanceof GmailContentTooLarge)) throw error;
        return {
          ...(await request<GmailMessage>(`messages/${encodeURIComponent(id)}?format=metadata`)),
          contentOmitted: true,
        };
      }
    },
    raw: (id: string) => request<GmailMessage>(`messages/${encodeURIComponent(id)}?format=raw`),
    attachment: (id: string, attachmentId: string) =>
      request<{ data: string; size: number }>(
        `messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`,
      ),
    watch: (topicName: string) =>
      request<{ historyId: string; expiration: string }>("watch", {
        method: "POST",
        body: JSON.stringify({ topicName }),
      }),
    modify: (id: string, addLabelIds: string[], removeLabelIds: string[]) =>
      request<GmailMessage>(`messages/${encodeURIComponent(id)}/modify`, {
        method: "POST",
        body: JSON.stringify({ addLabelIds, removeLabelIds }),
      }),
    stop: () => request<void>("stop", { method: "POST" }),
    send: (raw: string, threadId?: string) =>
      request<{ id: string; threadId: string }>("messages/send", {
        method: "POST",
        body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }),
      }),
  };
}
export async function googleToken(
  body: Record<string, string>,
  fetcher: typeof fetch = fetch,
): Promise<{ access_token: string; refresh_token?: string; scope?: string }> {
  const response = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new GmailError(response.status, "token");
  const result = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
  };
  if (!result.access_token) throw new Error("Google returned no access token");
  return { ...result, access_token: result.access_token };
}
export const refreshAccessToken = (credentials: Credentials, fetcher: typeof fetch = fetch) =>
  googleToken(
    {
      grant_type: "refresh_token",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
    },
    fetcher,
  );
export const allParts = (part: GmailPart): GmailPart[] => [
  part,
  ...(part.parts ?? []).flatMap(allParts),
];
export function parseMailbox(value: string): { email: string; name?: string } {
  const match = value.match(/^\s*(.*?)\s*<([^<>]+)>\s*$/);
  return match
    ? {
        email: match[2]!.trim().toLowerCase(),
        ...(match[1] ? { name: match[1].replace(/^"|"$/g, "") } : {}),
      }
    : { email: value.trim().toLowerCase() };
}
export function mailboxList(value: string): string[] {
  return (value.match(/(?:"[^"\\]*(?:\\.[^"\\]*)*"|[^,])+/g) ?? [])
    .map((entry) => parseMailbox(entry).email)
    .filter(Boolean);
}
export function decodeText(data: string, contentType?: string) {
  const charset = contentType?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(decodeBase64Url(data));
  } catch {
    return new TextDecoder().decode(decodeBase64Url(data));
  }
}
export const encodeBase64 = (bytes: Uint8Array) => {
  const unpadded = encodeBase64Url(bytes).replaceAll("-", "+").replaceAll("_", "/");
  return unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=");
};
export function messageMetadata(message: GmailMessage) {
  const header = (name: string) =>
    message.payload?.headers?.find((entry) => entry.name.toLowerCase() === name)?.value ?? "";
  return {
    providerMessageId: message.id,
    providerThreadId: message.threadId,
    ...(message.historyId ? { historyId: message.historyId } : {}),
    from: parseMailbox(header("from")),
    to: mailboxList(header("to")),
    cc: mailboxList(header("cc")),
    subject: header("subject").slice(0, 2000),
    snippet: (message.snippet ?? "").slice(0, 2000),
    receivedAt: Number(message.internalDate) || 0,
    labels: message.labelIds ?? [],
  };
}
/** Caller supplies a previously user-confirmed draft; header values cannot add recipients. */
export function draftMime(draft: {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  messageId: string;
  inReplyTo?: string;
  references?: string;
}) {
  const clean = (value: string) => {
    if (/[\r\n]/.test(value)) throw new Error("Mail header contains a newline");
    return value;
  };
  const lines = [
    `From: ${clean(draft.from)}`,
    `To: ${draft.to.map(clean).join(", ")}`,
    ...(draft.cc?.length ? [`Cc: ${draft.cc.map(clean).join(", ")}`] : []),
    `Subject: =?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(clean(draft.subject))))}?=`,
    `Message-ID: <${clean(draft.messageId)}>`,
    ...(draft.inReplyTo ? [`In-Reply-To: ${clean(draft.inReplyTo)}`] : []),
    ...(draft.references ? [`References: ${clean(draft.references)}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodeBase64(new TextEncoder().encode(draft.body))
      .match(/.{1,76}/g)
      ?.join("\r\n") ?? "",
  ];
  return encodeBase64Url(new TextEncoder().encode(lines.join("\r\n")));
}
