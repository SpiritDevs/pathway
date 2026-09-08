import * as Redacted from "effect/Redacted";
import { describe, it, expect, vi } from "vite-plus/test";
import {
  encodeBase64Url,
  decodeBase64Url,
  makeEnvelopeCipher,
  oauthBrowserCookie,
  hasOAuthBrowserCookie,
} from "./crypto.ts";
import { draftMime, mailboxList, decodeText, makeGmail } from "./gmail.ts";
import {
  MailStorageError,
  makePrivateMailStorage,
  materializeMessage,
  type PrivateMailStorage,
} from "./storage.ts";
import { makeMailRuntime, type MailRpc } from "./runtime.ts";
const key = encodeBase64Url(new Uint8Array(32).fill(7));
const config = {
  encryptionKey: Redacted.make(key),
  uploadThingApiKey: Redacted.make("storage"),
  pubsubTopic: "projects/test/topics/mail",
  pubsubServiceAccount: "push@example.com",
  hostedClientId: "hosted",
  hostedClientSecret: Redacted.make("secret"),
};
const encoded = (value: string) => encodeBase64Url(new TextEncoder().encode(value));
async function fixture(
  options: {
    cursor?: string;
    known?: boolean;
    expired?: boolean;
    page?: string;
    denyRenew?: boolean;
    sendFails?: boolean;
    historyCount?: number;
    cleanupFails?: boolean;
    draft?: boolean;
    ingestFails?: boolean;
    withoutPubsub?: boolean;
    privateStorageStatus?: number;
    tokenStatus?: number;
  } = {},
) {
  const encryptedCredentials = await makeEnvelopeCipher(key).seal(
    { clientId: "id", clientSecret: "secret", refreshToken: "refresh" },
    "credentials:owner:me@example.com",
  );
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let claimed = false;
  let state: string | undefined;
  const mutation = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    calls.push({ name, args });
    if (name === "claimSync")
      return {
        id: "account",
        ownerSubject: "owner",
        companyId: "company",
        email: "me@example.com",
        generation: 1,
        encryptedCredentials,
        ...(options.cursor ? { cursor: options.cursor } : {}),
      };
    if (name === "renewSync") return !options.denyRenew;
    if (name === "claimBlobCleanup" && options.cleanupFails)
      return [{ id: "cleanup", blobKeys: ["orphan"], generation: 1 }];
    if (
      name === "claimLabelUpdates" ||
      name === "claimBlobCleanup" ||
      name === "claimAccountCleanup"
    )
      return [];
    if (name === "claimOutbox") {
      if (!options.draft || claimed) return null;
      claimed = true;
      return {
        id: "draft",
        generation: 1,
        to: ["you@example.com"],
        subject: "Reply",
        text: "Hello",
      };
    }
    if (name === "putOAuthState") {
      state = String(args.encryptedState);
      return null;
    }
    if (name === "consumeOAuthState") {
      const previous = state;
      state = undefined;
      return previous ?? null;
    }
    if (name === "connectAccount") return { id: "account" };
    if (name === "ingestPage" && options.ingestFails) throw new Error("intake unavailable");
    return true;
  };
  const query = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    calls.push({ name, args });
    if (name === "getOwnedAccount")
      return {
        id: "account",
        ownerSubject: "owner",
        companyId: "company",
        email: "me@example.com",
        generation: 1,
        encryptedCredentials,
      };
    if (name === "dueAccounts") return [{ id: "account" }];
    if (name === "knownMessages")
      return options.known
        ? [{ providerMessageId: "m1", historyId: "old", rawBlobKey: "existing" }]
        : [];
    return true;
  };
  const rpc: MailRpc = {
    query: async <T>(name: string, args: Record<string, unknown>) => (await query(name, args)) as T,
    mutation: async <T>(name: string, args: Record<string, unknown>) =>
      (await mutation(name, args)) as T,
  };
  const requests: string[] = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    const text = String(url);
    requests.push(text);
    if (text.includes("/token"))
      return options.tokenStatus
        ? new Response(null, { status: options.tokenStatus })
        : Response.json({ access_token: "access", refresh_token: "refresh" });
    if (text === "https://api.uploadthing.com/v7/prepareUpload")
      return Response.json(
        { error: "provider response with private details" },
        {
          status: options.privateStorageStatus ?? 500,
        },
      );
    if (text.endsWith("/profile"))
      return Response.json({ emailAddress: "me@example.com", historyId: "baseline" });
    if (text.includes("/history?"))
      return options.expired
        ? new Response(null, { status: 404 })
        : Response.json({
            historyId: "latest",
            history: [
              {
                messagesAdded: Array.from({ length: options.historyCount ?? 1 }, (_, index) => ({
                  message: { id: `m${index + 1}` },
                })),
              },
            ],
          });
    if (text.includes("/messages?"))
      return Response.json({
        messages: [{ id: "m1" }],
        ...(options.page ? { nextPageToken: options.page } : {}),
      });
    if (text.endsWith("format=full"))
      return Response.json({
        id: "m1",
        threadId: "t1",
        historyId: "new",
        labelIds: ["UNREAD"],
        payload: {
          mimeType: "text/plain",
          headers: [{ name: "From", value: '"Sender, One" <sender@example.com>' }],
          body: { data: encoded("Email text"), size: 10 },
        },
      });
    if (text.endsWith("format=raw"))
      return Response.json({
        id: "m1",
        threadId: "t1",
        raw: encoded("From: sender@example.com\r\n\r\nEmail text"),
      });
    if (text.endsWith("/messages/send")) {
      if (options.sendFails) throw new Error("Response lost");
      return Response.json({ id: "sent-message", threadId: "sent-thread" });
    }
    throw new Error(`Unexpected fixture URL ${text}`);
  }) as typeof fetch;
  const storage: PrivateMailStorage = {
    put: vi.fn(async () => "blob"),
    signedUrl: vi.fn(async () => "https://private.example/file"),
    delete: vi.fn(async () => {
      if (options.cleanupFails) throw new Error("storage unavailable");
    }),
  };
  const enqueue = vi.fn(async () => {});
  return {
    runtime: makeMailRuntime({
      config: options.withoutPubsub
        ? { ...config, pubsubTopic: "", pubsubServiceAccount: "" }
        : config,
      origin: "https://connect.example",
      rpc,
      fetcher,
      storage: options.privateStorageStatus ? makePrivateMailStorage("test-key", fetcher) : storage,
      enqueue,
      now: () => 1000,
    }),
    calls,
    requests,
    storage,
    enqueue,
  };
}
describe("mail credentials and MIME", () => {
  it.each(["byo", "hosted"] as const)(
    "connects a %s mailbox without Pub/Sub and leaves watch setup disabled",
    async (credentialSource) => {
      const f = await fixture({ withoutPubsub: true });
      const { authorizationUrl } = await f.runtime.startOAuth({
        ownerSubject: "owner",
        companyId: "company",
        credentialSource,
        clientId: "id",
        clientSecret: "secret",
        ...(credentialSource === "hosted" ? { pubsubTopic: "projects/untrusted/topics/mail" } : {}),
      });
      await f.runtime.finishOAuth(new URL(authorizationUrl).searchParams.get("state")!, "code");
      const credentials = f.calls.find((call) => call.name === "connectAccount")?.args
        .encryptedCredentials;
      expect(typeof credentials).toBe("string");
      const decoded = await makeEnvelopeCipher(key).open<Record<string, unknown>>(
        credentials as string,
        "credentials:owner:me@example.com",
      );
      expect(decoded).not.toHaveProperty("pubsubTopic");
    },
  );

  it("rejects a push topic when no delivery identity is configured", async () => {
    const f = await fixture({ withoutPubsub: true });
    await expect(
      f.runtime.startOAuth({
        ownerSubject: "owner",
        companyId: "company",
        credentialSource: "byo",
        clientId: "id",
        clientSecret: "secret",
        pubsubTopic: "projects/project/topics/mail",
      }),
    ).rejects.toThrow("Leave the Pub/Sub topic empty");
    expect(f.calls.some((call) => call.name === "putOAuthState")).toBe(false);
  });
  it("binds encrypted records to the owner", async () => {
    const cipher = makeEnvelopeCipher(key);
    const sealed = await cipher.seal({ refreshToken: "sensitive" }, "owner-a");
    expect(sealed).not.toContain("sensitive");
    expect(await cipher.open(sealed, "owner-a")).toEqual({ refreshToken: "sensitive" });
    await expect(cipher.open(sealed, "owner-b")).rejects.toThrow();
  });
  it("handles quoted addresses, charsets and valid padded MIME base64", () => {
    expect(mailboxList('"Smith, Jane" <jane@example.com>, other@example.com')).toEqual([
      "jane@example.com",
      "other@example.com",
    ]);
    expect(
      decodeText(
        encodeBase64Url(new Uint8Array([0x63, 0x61, 0x66, 0xe9])),
        "text/plain; charset=iso-8859-1",
      ),
    ).toBe("café");
    expect(() =>
      draftMime({
        from: "me@example.com",
        to: ["you@example.com\r\nBcc: outsider@example.com"],
        subject: "Hi",
        body: "Hi",
        messageId: "id",
      }),
    ).toThrow("newline");
    const raw = new TextDecoder().decode(
      decodeBase64Url(
        draftMime({
          from: "me@example.com",
          to: ["you@example.com"],
          subject: "Hi 🌍",
          body: "Hi",
          messageId: "id",
          inReplyTo: "<original@example.com>",
        }),
      ),
    );
    expect(raw).toContain("In-Reply-To: <original@example.com>");
    expect(raw).toMatch(/SGk=$/);
  });
  it("uses PKCE and consumes OAuth state once", async () => {
    const f = await fixture();
    const { authorizationUrl } = await f.runtime.startOAuth({
      ownerSubject: "owner",
      companyId: "company",
      credentialSource: "byo",
      clientId: "id",
      clientSecret: "secret",
    });
    const url = new URL(authorizationUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl).not.toContain("secret");
    await f.runtime.finishOAuth(url.searchParams.get("state")!, "code");
    expect(f.calls.find((c) => c.name === "connectAccount")?.args).toMatchObject({
      ownerSubject: "owner",
      companyId: "company",
      oauthClientId: "id",
    });
    await expect(f.runtime.finishOAuth(url.searchParams.get("state")!, "code")).rejects.toThrow(
      "expired",
    );
  });
});
describe("Gmail synchronization", () => {
  it("commits continuation before queueing without advancing cursor", async () => {
    const f = await fixture({ page: "page2" });
    await f.runtime.process({ accountId: "account" });
    const finish = f.calls.find((c) => c.name === "finishSync");
    expect(finish?.args).toMatchObject({
      continuation: { mode: "backfill", pageToken: "page2", baselineCursor: "baseline" },
    });
    expect(finish?.args).not.toHaveProperty("cursor");
    expect(f.enqueue).toHaveBeenCalledWith({ accountId: "account" });
    expect(f.requests.find((url) => url.includes("/messages?"))).toContain("newer_than%3A1y");
  });
  it("resyncs after a history 404", async () => {
    const f = await fixture({ cursor: "expired", expired: true });
    await f.runtime.process({ accountId: "account" });
    expect(f.calls.find((c) => c.name === "finishSync")?.args.cursor).toBe("baseline");
  });
  it("changes labels without reuploading mail content", async () => {
    const f = await fixture({ cursor: "previous", known: true });
    await f.runtime.process({ accountId: "account" });
    expect(f.storage.put).not.toHaveBeenCalled();
    expect(f.requests.some((url) => url.includes("format=raw"))).toBe(false);
  });
  it("stops on a lost lease before fetching message content", async () => {
    const f = await fixture({ denyRenew: true });
    await expect(f.runtime.process({ accountId: "account" })).rejects.toThrow();
    expect(f.storage.put).not.toHaveBeenCalled();
    expect(f.requests.some((url) => url.includes("format=full"))).toBe(false);
  });
  it("never publishes a cursor after rejected intake", async () => {
    const f = await fixture({ ingestFails: true });
    await expect(f.runtime.process({ accountId: "account" })).rejects.toThrow();
    expect(f.calls.some((c) => c.name === "finishSync")).toBe(false);
  });
  it("only sends queued drafts and leaves uncertain deliveries unknown", async () => {
    const idle = await fixture();
    await idle.runtime.process({ accountId: "account" });
    expect(idle.requests.some((url) => url.endsWith("/send"))).toBe(false);
    const f = await fixture({ draft: true, sendFails: true });
    await f.runtime.process({ accountId: "account" });
    expect(f.requests.filter((url) => url.endsWith("/send"))).toHaveLength(1);
    expect(f.calls.find((c) => c.name === "finishOutbox")?.args.status).toBe("unknown");
  });
  it("falls back to metadata when a Gmail response exceeds the bounded download", async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      String(url).endsWith("format=full")
        ? new Response(new Uint8Array(8 * 1024 * 1024 + 1))
        : Response.json({ id: "large", threadId: "thread" }),
    ) as typeof fetch;
    expect(await makeGmail("token", fetcher).message("large")).toMatchObject({
      contentOmitted: true,
      id: "large",
    });
  });
});
it("registers crash cleanup before private upload and issues short downloads", async () => {
  const requests: unknown[] = [];
  const order: string[] = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(typeof init?.body === "string" ? JSON.parse(init.body) : init?.body);
    if (String(url).endsWith("prepareUpload"))
      return Response.json({ key: "key", url: "https://sea1.ingest.uploadthing.com/key" });
    if (String(url).endsWith("requestFileAccess"))
      return Response.json({ ufsUrl: "https://app.ufs.sh/f/key?signature=test" });
    order.push("upload");
    return Response.json({ key: "key" });
  }) as typeof fetch;
  const storage = makePrivateMailStorage("test-key", fetcher, async () => {
    order.push("registered");
  });
  await storage.put("file.txt", "text/plain", new Uint8Array([1]), "stable-id");
  expect(requests[0]).toMatchObject({
    acl: "private",
    contentDisposition: "attachment",
    customId: "stable-id",
  });
  expect(order).toEqual(["registered", "upload"]);
  await storage.signedUrl("key");
  expect(requests[2]).toMatchObject({ fileKey: "key", expiresIn: 60 });
});

it("requires OAuth callback cookie from the initiating browser", async () => {
  const cookie = await oauthBrowserCookie("state");
  expect(await hasOAuthBrowserCookie("state", null)).toBe(false);
  expect(await hasOAuthBrowserCookie("another", `${cookie.name}=${cookie.value}`)).toBe(false);
  expect(await hasOAuthBrowserCookie("state", `${cookie.name}=${cookie.value}`)).toBe(true);
});
it("dispatches user-confirmed sends independently of the ingest lease", async () => {
  const f = await fixture({ draft: true });
  await f.runtime.process({
    accountId: "account",
    kind: "user-action",
    ownerSubject: "owner",
    companyId: "company",
  });
  expect(f.calls.some((call) => call.name === "claimSync")).toBe(false);
  expect(f.requests.some((url) => url.endsWith("/messages/send"))).toBe(true);
});
it("retains offsets when a bulk history record exceeds one delivery", async () => {
  const f = await fixture({ cursor: "before", known: true, historyCount: 12 });
  await f.runtime.process({ accountId: "account" });
  expect(f.calls.find((c) => c.name === "finishSync")?.args).toMatchObject({
    continuation: {
      mode: "history",
      pageToken: "",
      baselineCursor: "before",
      messageOffset: 10,
      deletedOffset: 0,
    },
  });
  expect(f.requests.filter((url) => url.endsWith("format=full"))).toHaveLength(10);
});

it("continues mailbox reconciliation during a storage cleanup outage", async () => {
  const f = await fixture({ cleanupFails: true });
  await f.runtime.reconcile();
  expect(f.enqueue).toHaveBeenCalledWith({ accountId: "account" });
  expect(f.calls.some((c) => c.name === "finishBlobCleanup")).toBe(false);
});

describe("materialized message attachment limits", () => {
  it.each([1, 6 * 1024 * 1024])(
    "bounds attachment metadata and preserves later bodies with %i-byte attachments",
    async (attachmentSize) => {
      const fetcher = vi.fn(async () => {
        throw new Error("Omitted attachments must not be downloaded");
      }) as typeof fetch;
      const storage: PrivateMailStorage = {
        put: vi.fn(async (name) => name),
        signedUrl: vi.fn(),
        delete: vi.fn(async () => {}),
      };
      const result = await materializeMessage(
        {
          id: "many-attachments",
          threadId: "thread",
          sizeEstimate: 6 * 1024 * 1024,
          payload: {
            mimeType: "multipart/mixed",
            parts: [
              ...Array.from({ length: 100 }, (_, index) => ({
                partId: String(index),
                filename: `attachment-${index}.txt`,
                mimeType: "text/plain",
                body: {
                  size: attachmentSize,
                  ...(index < 40 ? { data: encoded("a") } : { attachmentId: String(index) }),
                },
              })),
              { mimeType: "text/plain", body: { data: encoded("Message text") } },
              { mimeType: "text/html", body: { data: encoded("<p>Message text</p>") } },
            ],
          },
        },
        makeGmail("token", fetcher),
        storage,
      );
      expect(result).toMatchObject({
        textBody: "Message text",
        htmlBody: "<p>Message text</p>",
        bodyTruncated: true,
      });
      expect(result.attachments).toHaveLength(40);
      expect(storage.put).toHaveBeenCalledTimes(attachmentSize === 1 ? 40 : 0);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("marks an oversized body incomplete without misrepresenting it as an attachment", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("Oversized bodies must not be downloaded");
    }) as typeof fetch;
    const storage: PrivateMailStorage = {
      put: vi.fn(),
      signedUrl: vi.fn(),
      delete: vi.fn(),
    };
    const result = await materializeMessage(
      {
        id: "oversized-body",
        threadId: "thread",
        sizeEstimate: 6 * 1024 * 1024,
        payload: {
          mimeType: "text/plain",
          body: { size: 6 * 1024 * 1024, attachmentId: "body" },
        },
      },
      makeGmail("token", fetcher),
      storage,
    );
    expect(result).toMatchObject({ bodyTruncated: true, attachments: [], textBody: "" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });
});

describe("materialized message upload leases", () => {
  async function largeBodyFixture(loseAfterBody = false) {
    let elapsed = 0;
    let expiresAt = 120_000;
    let lost = false;
    const renew = async () => {
      if (lost || elapsed >= expiresAt) throw new Error("Sync lease lost");
      expiresAt = elapsed + 120_000;
    };
    const fetcher = vi.fn(async () => {
      elapsed += 25_000;
      return Response.json({ raw: encoded("raw message") });
    }) as typeof fetch;
    const storage: PrivateMailStorage = {
      put: vi.fn(async (name) => {
        elapsed += 85_000;
        if (elapsed >= expiresAt) throw new Error("Upload outlasted sync lease");
        if (name.endsWith("-body.json")) lost = loseAfterBody;
        return name;
      }),
      signedUrl: vi.fn(),
      delete: vi.fn(async () => {}),
    };
    const result = materializeMessage(
      {
        id: "large-body",
        threadId: "thread",
        sizeEstimate: 100_000,
        payload: { mimeType: "text/plain", body: { data: encoded("x".repeat(97_000)) } },
      },
      makeGmail("token", fetcher),
      storage,
      renew,
      "account",
    );
    return { result, storage, remainingLease: () => expiresAt - elapsed };
  }

  it("keeps sequential raw and large-body uploads within a renewed sync lease", async () => {
    const f = await largeBodyFixture();
    await expect(f.result).resolves.toMatchObject({
      rawBlobKey: "large-body.eml",
      bodyBlobKey: "large-body-body.json",
      bodyTruncated: true,
    });
    expect(f.remainingLease()).toBe(120_000);
    expect(f.storage.delete).not.toHaveBeenCalled();
  });

  it("rejects materialization and cleans up uploads when the final renewal loses ownership", async () => {
    const f = await largeBodyFixture(true);
    await expect(f.result).rejects.toThrow("Sync lease lost");
    expect(f.storage.delete).toHaveBeenCalledWith(["large-body.eml", "large-body-body.json"]);
  });
});

describe("mail sync failure diagnostics", () => {
  it.each([400, 401, 403, 500])(
    "identifies private storage HTTP %i without requiring Google reconnect",
    async (status) => {
      const f = await fixture({ privateStorageStatus: status });
      await expect(f.runtime.process({ accountId: "account" })).rejects.toThrow(
        "Private mail storage",
      );
      const failure = f.calls.find((call) => call.name === "failSync");
      expect(failure?.args).toMatchObject({ needsReauth: false });
      expect(failure?.args.error).toContain(`HTTP ${status}`);
      expect(failure?.args.error).not.toContain("private details");
      expect(f.calls.some((call) => call.name === "finishSync" || call.name === "ingestPage")).toBe(
        false,
      );
    },
  );

  it("retries the message after private storage recovers", async () => {
    const f = await fixture();
    vi.mocked(f.storage.put).mockRejectedValueOnce(new MailStorageError(503, "upload"));
    await expect(f.runtime.process({ accountId: "account" })).rejects.toThrow("HTTP 503");
    await f.runtime.process({ accountId: "account" });
    expect(f.calls.filter((call) => call.name === "ingestPage")).toHaveLength(1);
    expect(f.calls.filter((call) => call.name === "finishSync")).toHaveLength(1);
  });

  it("retains the failed step without exposing unexpected backend error details", async () => {
    const f = await fixture({ ingestFails: true });
    await expect(f.runtime.process({ accountId: "account" })).rejects.toThrow("saving a message");
    expect(f.calls.find((call) => call.name === "failSync")?.args.error).toBe(
      "Mailbox synchronization failed while saving a message; it will retry.",
    );
  });

  it("still requests reconnection when Google authorization expires", async () => {
    const f = await fixture({ tokenStatus: 400 });
    await f.runtime.process({ accountId: "account" });
    expect(f.calls.find((call) => call.name === "failSync")?.args).toMatchObject({
      needsReauth: true,
      error: "Google authorization expired. Reconnect this mailbox.",
    });
  });
});
