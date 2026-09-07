// @effect-diagnostics globalDate:off - Promise runtime boundary; clock injected for fixture tests.
import * as Redacted from "effect/Redacted";
import {
  type Credentials,
  GmailError,
  googleToken,
  makeGmail,
  refreshAccessToken,
  draftMime,
  messageMetadata,
} from "./gmail.ts";
import { makeEnvelopeCipher, randomToken, hashToken } from "./crypto.ts";
import { makePrivateMailStorage, materializeMessage, type PrivateMailStorage } from "./storage.ts";
import type { MailConfiguration } from "./config.ts";

export interface MailContinuation {
  mode: "backfill" | "history";
  pageToken: string;
  baselineCursor: string;
  messageOffset?: number;
  deletedOffset?: number;
}
export interface RelayMailAccount {
  id: string;
  email: string;
  ownerSubject: string;
  companyId: string;
  encryptedCredentials: string;
  generation: number;
  cursor?: string;
  continuation?: MailContinuation;
  watchExpiresAt?: number;
}
export interface MailRpc {
  query<T>(name: string, args: Record<string, unknown>): Promise<T>;
  mutation<T>(name: string, args: Record<string, unknown>): Promise<T>;
}
interface OAuthState {
  ownerSubject: string;
  companyId: string;
  clientId: string;
  clientSecret: string;
  credentialSource: "byo" | "hosted";
  verifier: string;
  expiresAt: number;
  pubsubTopic?: string;
}
interface OutboxDraft {
  id: string;
  generation: number;
  to: string[];
  subject: string;
  text: string;
  replyToProviderThreadId?: string;
  replyToProviderMessageId?: string;
  inReplyTo?: string;
  references?: string;
}
export type MailQueueJob = {
  accountId: string;
  kind?: "user-action";
  ownerSubject?: string;
  companyId?: string;
};
export function makeMailRuntime(input: {
  config: MailConfiguration;
  origin: string;
  rpc: MailRpc;
  enqueue: (job: MailQueueJob) => Promise<void>;
  fetcher?: typeof fetch;
  storage?: PrivateMailStorage;
  now?: () => number;
}) {
  const { config, rpc, enqueue } = input;
  const now = input.now ?? Date.now;
  const fetcher = input.fetcher ?? fetch;
  const cipher = makeEnvelopeCipher(Redacted.value(config.encryptionKey));
  const storage =
    input.storage ??
    makePrivateMailStorage(Redacted.value(config.uploadThingApiKey), fetcher, async (key) => {
      await rpc.mutation("registerBlobCleanup", { blobKeys: [key] });
    });
  const redirectUri = `${input.origin}/v1/mail/oauth/callback`;
  const credentialContext = (ownerSubject: string, email: string) =>
    `credentials:${ownerSubject}:${email.toLowerCase()}`;
  const gmailFor = async (account: RelayMailAccount) => {
    const credentials = await cipher.open<Credentials>(
      account.encryptedCredentials,
      credentialContext(account.ownerSubject, account.email),
    );
    const token = await refreshAccessToken(credentials, fetcher);
    return makeGmail(token.access_token, fetcher);
  };
  const applyLabels = async (
    account: RelayMailAccount,
    gmail: ReturnType<typeof makeGmail>,
    renew: () => Promise<void> = async () => {},
  ) => {
    const labelToken = randomToken();
    const labelUpdates = await rpc.mutation<
      Array<{ id: string; providerMessageId: string; read: boolean; generation: number }>
    >("claimLabelUpdates", { accountId: account.id, leaseToken: labelToken });
    for (const update of labelUpdates.slice(0, 10)) {
      await renew();
      let success = false;
      try {
        await gmail.modify(
          update.providerMessageId,
          update.read ? [] : ["UNREAD"],
          update.read ? ["UNREAD"] : [],
        );
        success = true;
      } catch {
        /* Backend retains the failed write for retry. */
      }
      await rpc.mutation("finishLabelUpdate", {
        id: update.id,
        leaseToken: labelToken,
        generation: update.generation,
        success,
        ...(success ? {} : { error: "Gmail could not update this message. It will retry." }),
      });
    }
  };
  const deliverOutbox = async (account: RelayMailAccount, gmail: ReturnType<typeof makeGmail>) => {
    const outboxToken = randomToken();
    for (let count = 0; count < 5; count++) {
      const draft = await rpc.mutation<OutboxDraft | null>("claimOutbox", {
        accountId: account.id,
        leaseToken: outboxToken,
      });
      if (!draft) break;
      let status: "sent" | "failed" | "unknown" = "unknown";
      let providerMessageId: string | undefined;
      let errorMessage: string | undefined;
      try {
        let replyHeaders: { inReplyTo?: string; references?: string } = {};
        if (draft.replyToProviderMessageId) {
          const original = await gmail.message(draft.replyToProviderMessageId);
          const header = (name: string) =>
            original.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value;
          const messageId = header("message-id");
          if (messageId)
            replyHeaders = {
              inReplyTo: messageId,
              references: [header("references"), messageId].filter(Boolean).join(" "),
            };
        }
        const raw = draftMime({
          from: account.email,
          to: draft.to,
          subject: draft.subject,
          body: draft.text,
          messageId: `${draft.id}@mail.pathway`,
          ...replyHeaders,
        });
        const sent = await gmail.send(raw, draft.replyToProviderThreadId);
        providerMessageId = sent.id;
        status = "sent";
      } catch (error) {
        status =
          error instanceof GmailError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408
            ? "failed"
            : "unknown";
        errorMessage =
          status === "unknown"
            ? "Delivery could not be confirmed. Check Gmail Sent before retrying."
            : "Google rejected this message.";
      }
      // A lost acknowledgement must stay unknown; the backend never automatically reclaims sending rows.
      await rpc.mutation("finishOutbox", {
        draftId: draft.id,
        leaseToken: outboxToken,
        generation: draft.generation,
        status,
        ...(providerMessageId ? { providerMessageId } : {}),
        ...(errorMessage ? { error: errorMessage } : {}),
      });
    }
  };
  return {
    async startOAuth(request: {
      ownerSubject: string;
      companyId: string;
      credentialSource: "byo" | "hosted";
      clientId?: string;
      clientSecret?: string;
      pubsubTopic?: string;
    }) {
      await rpc.query("assertOwner", {
        ownerSubject: request.ownerSubject,
        companyId: request.companyId,
      });
      const clientId =
        request.credentialSource === "hosted" ? config.hostedClientId : request.clientId;
      const clientSecret =
        request.credentialSource === "hosted"
          ? Redacted.value(config.hostedClientSecret)
          : request.clientSecret;
      if (!clientId || !clientSecret || clientId.length > 1000 || clientSecret.length > 2000)
        throw new Error("Google OAuth credentials are required");
      const state = randomToken(),
        verifier = randomToken();
      const stateHash = await hashToken(state);
      const expiresAt = now() + 10 * 60_000;
      const encryptedState = await cipher.seal(
        {
          ownerSubject: request.ownerSubject,
          companyId: request.companyId,
          credentialSource: request.credentialSource,
          clientId,
          clientSecret,
          verifier,
          expiresAt,
          ...(request.pubsubTopic ? { pubsubTopic: request.pubsubTopic } : {}),
        } satisfies OAuthState,
        `oauth:${stateHash}`,
      );
      await rpc.mutation("putOAuthState", { stateHash, encryptedState, expiresAt });
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/gmail.modify",
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: await hashToken(verifier),
        code_challenge_method: "S256",
      }).toString();
      return { authorizationUrl: url.toString() };
    },
    async finishOAuth(state: string, code: string) {
      if (state.length > 500 || code.length > 4000)
        throw new Error("Invalid Google authorization response");
      const stateHash = await hashToken(state);
      const encrypted = await rpc.mutation<string | null>("consumeOAuthState", { stateHash });
      if (!encrypted) throw new Error("Authorization expired. Connect Gmail again.");
      const pending = await cipher.open<OAuthState>(encrypted, `oauth:${stateHash}`);
      if (pending.expiresAt < now()) throw new Error("Authorization expired. Connect Gmail again.");
      const tokens = await googleToken(
        {
          grant_type: "authorization_code",
          code,
          client_id: pending.clientId,
          client_secret: pending.clientSecret,
          redirect_uri: redirectUri,
          code_verifier: pending.verifier,
        },
        fetcher,
      );
      if (!tokens.refresh_token)
        throw new Error("Google did not grant offline access. Connect Gmail again.");
      if (
        tokens.scope &&
        !tokens.scope.split(" ").includes("https://www.googleapis.com/auth/gmail.modify")
      )
        throw new Error("Gmail read and send access is required");
      const profile = await makeGmail(tokens.access_token, fetcher).profile();
      const encryptedCredentials = await cipher.seal(
        {
          clientId: pending.clientId,
          clientSecret: pending.clientSecret,
          refreshToken: tokens.refresh_token,
          ...(pending.credentialSource === "hosted"
            ? { pubsubTopic: config.pubsubTopic }
            : pending.pubsubTopic
              ? { pubsubTopic: pending.pubsubTopic }
              : {}),
        } satisfies Credentials,
        credentialContext(pending.ownerSubject, profile.emailAddress),
      );
      const account = await rpc.mutation<{ id: string }>("connectAccount", {
        ownerSubject: pending.ownerSubject,
        companyId: pending.companyId,
        email: profile.emailAddress,
        credentialSource: pending.credentialSource,
        encryptedCredentials,
      });
      await enqueue({ accountId: account.id });
      return account;
    },
    async wake(ownerSubject: string, companyId: string, accountId: string) {
      await rpc.query("getOwnedAccount", { ownerSubject, companyId, accountId });
      await enqueue({ accountId, kind: "user-action", ownerSubject, companyId });
    },
    async notify(email: string) {
      const accounts = await rpc.query<Array<{ id: string }>>("findByEmail", { email });
      for (const account of accounts) await enqueue({ accountId: account.id });
    },
    async reconcile() {
      await rpc.mutation("sweepUnavailableAccounts", {});
      const cleanupToken = randomToken();
      const blobs = await rpc.mutation<
        Array<{ id: string; blobKeys: string[]; generation: number }>
      >("claimBlobCleanup", { leaseToken: cleanupToken, limit: 50 });
      try {
        await storage.delete(blobs.flatMap((row) => row.blobKeys));
        for (const row of blobs)
          await rpc.mutation("finishBlobCleanup", {
            id: row.id,
            leaseToken: cleanupToken,
            generation: row.generation,
          });
      } catch {
        /* Lease expiry retries cleanup without interrupting mailbox polling. */
      }
      const disconnected = await rpc.mutation<
        Array<{
          id: string;
          accountId: string;
          ownerSubject: string;
          email: string;
          encryptedCredentials: string;
          generation: number;
          revoke?: boolean;
        }>
      >("claimAccountCleanup", { leaseToken: cleanupToken, limit: 10 });
      await Promise.allSettled(
        disconnected.map(async (row) => {
          if (row.revoke !== false) {
            const credentials = await cipher.open<Credentials>(
              row.encryptedCredentials,
              credentialContext(row.ownerSubject, row.email),
            );
            const response = await fetcher("https://oauth2.googleapis.com/revoke", {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ token: credentials.refreshToken }),
              signal: AbortSignal.timeout(25_000),
            });
            if (!response.ok && response.status !== 400)
              throw new Error("Google disconnect failed; will retry");
          }
          await rpc.mutation("finishAccountCleanup", {
            id: row.id,
            leaseToken: cleanupToken,
            generation: row.generation,
          });
        }),
      );
      const accounts = await rpc.query<Array<{ id: string }>>("dueAccounts", { limit: 100 });
      for (const account of accounts) await enqueue({ accountId: account.id });
    },
    async disconnect(ownerSubject: string, companyId: string, accountId: string) {
      await rpc.mutation("disconnectAccount", { ownerSubject, companyId, accountId });
    },
    async download(ownerSubject: string, companyId: string, messageId: string, blobKey: string) {
      const allowed = await rpc.query<unknown>("getOwnedBlob", {
        ownerSubject,
        companyId,
        messageId,
        blobKey,
      });
      if (!allowed) throw new Error("Mail attachment not found");
      return { url: await storage.signedUrl(blobKey) };
    },
    async process(job: MailQueueJob) {
      if (job.kind === "user-action") {
        if (!job.ownerSubject || !job.companyId) throw new Error("Invalid owner-bound mail job");
        const account = await rpc.query<RelayMailAccount>("getOwnedAccount", {
          ownerSubject: job.ownerSubject,
          companyId: job.companyId,
          accountId: job.accountId,
        });
        const gmail = await gmailFor(account);
        await applyLabels(account, gmail);
        await deliverOutbox(account, gmail);
        return;
      }
      const leaseToken = randomToken();
      const account = await rpc.mutation<RelayMailAccount | null>("claimSync", {
        accountId: job.accountId,
        leaseToken,
      });
      if (!account) return;
      const lease = { accountId: account.id, leaseToken, generation: account.generation };
      let syncFinished = false;
      try {
        const credentials = await cipher.open<Credentials>(
          account.encryptedCredentials,
          credentialContext(account.ownerSubject, account.email),
        );
        const gmail = await gmailFor(account);
        await applyLabels(account, gmail, async () => {
          if ((await rpc.mutation("renewSync", lease)) !== true)
            throw new Error("Mailbox lease expired");
        });
        let watchExpiresAt = account.watchExpiresAt;
        let watchError: string | undefined;
        if (
          credentials.pubsubTopic &&
          (!watchExpiresAt || watchExpiresAt < now() + 6 * 24 * 60 * 60_000)
        ) {
          try {
            const watch = await gmail.watch(credentials.pubsubTopic);
            watchExpiresAt = Number(watch.expiration);
          } catch {
            watchError =
              "Instant delivery is unavailable; checking Gmail every five minutes. Verify Pub/Sub topic access.";
          }
        }
        let continuation = account.continuation;
        let mode = continuation?.mode ?? (account.cursor ? "history" : "backfill");
        let baselineCursor =
          continuation?.baselineCursor ?? account.cursor ?? (await gmail.profile()).historyId;
        let ids: string[] = [];
        let deletedIds: string[] = [];
        let nextPageToken: string | undefined;
        let finalCursor = baselineCursor;
        if (mode === "history") {
          try {
            const history = await gmail.history(baselineCursor, continuation?.pageToken);
            nextPageToken = history.nextPageToken;
            finalCursor = history.historyId;
            ids = [
              ...new Set(
                (history.history ?? []).flatMap((row) =>
                  [
                    ...(row.messagesAdded ?? []),
                    ...(row.labelsAdded ?? []),
                    ...(row.labelsRemoved ?? []),
                  ].map((item) => item.message.id),
                ),
              ),
            ];
            deletedIds = [
              ...new Set(
                (history.history ?? []).flatMap((row) =>
                  (row.messagesDeleted ?? []).map((item) => item.message.id),
                ),
              ),
            ];
          } catch (error) {
            if (!(error instanceof GmailError) || error.status !== 404) throw error;
            mode = "backfill";
            continuation = undefined;
            baselineCursor = (await gmail.profile()).historyId;
            finalCursor = baselineCursor;
          }
        }
        if (mode === "backfill") {
          const page = await gmail.list(continuation?.pageToken);
          ids = (page.messages ?? []).map((row) => row.id);
          nextPageToken = page.nextPageToken;
        }
        // Persist each message separately: a crash replays provider identities, never a partially advanced cursor.
        const messageOffset = continuation?.messageOffset ?? 0;
        const deletedOffset = continuation?.deletedOffset ?? 0;
        const pageIds = ids.slice(messageOffset, messageOffset + 10);
        const pageDeletedIds = deletedIds.slice(deletedOffset, deletedOffset + 100);
        for (const id of pageIds) {
          try {
            if ((await rpc.mutation("renewSync", lease)) !== true)
              throw new Error("Mailbox lease expired");
            const message = await gmail.message(id);
            const known = await rpc.query<
              Array<{ providerMessageId: string; historyId?: string; rawBlobKey?: string }>
            >("knownMessages", { accountId: account.id, providerMessageIds: [id] });
            if (known[0]?.historyId && known[0].historyId === message.historyId) continue;
            if (known[0]) {
              await rpc.mutation("ingestPage", {
                ...lease,
                messages: [{ ...messageMetadata(message), attachments: [] }],
              });
              continue;
            }
            const materialized = await materializeMessage(
              message,
              gmail,
              storage,
              async () => {
                if ((await rpc.mutation("renewSync", lease)) !== true)
                  throw new Error("Mailbox lease expired");
              },
              `${account.companyId}:${account.id}`,
            );
            await rpc.mutation("ingestPage", { ...lease, messages: [materialized] });
          } catch (error) {
            if (error instanceof GmailError && error.status === 404) {
              pageDeletedIds.push(id);
              continue;
            }
            throw error;
          }
        }
        for (let offset = 0; offset < pageDeletedIds.length; offset += 100) {
          await rpc.mutation("deleteMessages", {
            ...lease,
            providerMessageIds: pageDeletedIds.slice(offset, offset + 100),
          });
        }
        const pageIncomplete =
          messageOffset + pageIds.length < ids.length || deletedOffset + 100 < deletedIds.length;
        const nextContinuation = pageIncomplete
          ? {
              mode,
              pageToken: continuation?.pageToken ?? "",
              baselineCursor,
              messageOffset: messageOffset + pageIds.length,
              deletedOffset: Math.min(deletedOffset + 100, deletedIds.length),
            }
          : nextPageToken
            ? { mode, pageToken: nextPageToken, baselineCursor }
            : undefined;
        await rpc.mutation("finishSync", {
          ...lease,
          ...(nextContinuation ? { continuation: nextContinuation } : { cursor: finalCursor }),
          ...(watchExpiresAt ? { watchExpiresAt } : {}),
          ...(watchError ? { watchError } : {}),
          nextSyncAt: nextContinuation ? now() : now() + 5 * 60_000,
        });
        syncFinished = true;
        if (nextContinuation) await enqueue({ accountId: account.id });
        await deliverOutbox(account, gmail);
      } catch (error) {
        const needsReauth =
          error instanceof GmailError &&
          (error.status === 401 || (error.operation === "token" && error.status === 400));
        if (!syncFinished)
          await rpc.mutation("failSync", {
            ...lease,
            error: needsReauth
              ? "Google authorization expired. Reconnect this mailbox."
              : "Mailbox synchronization failed; it will retry.",
            needsReauth,
          });
        if (!needsReauth) throw new Error("Mailbox synchronization failed", { cause: error });
      }
    },
  };
}
export type MailRuntime = ReturnType<typeof makeMailRuntime>;
