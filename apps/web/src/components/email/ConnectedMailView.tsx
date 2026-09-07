import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, MailIcon, SettingsIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { companyListAtom } from "../../cloud/activeCompany";
import {
  companyRegistryMembershipIdsAtom,
  companyRegistryReplicasAtom,
} from "../../cloud/companyRegistryReplica";
import { ensureLocalApi } from "../../localApi";
import { cn, randomUUID } from "../../lib/utils";
import { canManageContactsFromReplica } from "../contacts/contactPermissions";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { WorkspaceViewFrame } from "../workspace/WorkspaceViewFrame";
import { useConnectedMailCloud, useMailQuery, type ConnectedMailCloud } from "./connectedMailCloud";
import { canDiscardMailDraft, gmailMessageUrl } from "./connectedMail.logic";
import { beginMailAttachmentDownload } from "./mailAttachmentDownload";
import type { ConnectedDraft, ConnectedMailAccount, ConnectedMessage } from "./connectedMail.types";
import {
  buildEmailPreviewDocument,
  EMAIL_PREVIEW_SANDBOX,
  hasRemoteEmailContent,
  type EmailSearch,
  type EmailSearchPatch,
} from "./emailView.logic";

type MailPage = { messages: ConnectedMessage[]; nextCursor: string | null };
const problem = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function DraftEditor({
  cloud,
  account,
  replyTo,
  draft,
  onClose,
}: {
  cloud: ConnectedMailCloud;
  account: ConnectedMailAccount;
  replyTo?: ConnectedMessage;
  draft?: ConnectedDraft;
  onClose: () => void;
}) {
  const [to, setTo] = useState(draft?.to.join(", ") ?? replyTo?.from.email ?? "");
  const [subject, setSubject] = useState(
    draft?.subject ?? (replyTo ? `Re: ${replyTo.subject.replace(/^re:\s*/i, "")}` : ""),
  );
  const [text, setText] = useState(draft?.text ?? "");
  const [draftId, setDraftId] = useState(draft?.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const locked = !canDiscardMailDraft(draft?.status);
  const discard = async () => {
    if (busy || locked) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      if (draftId) await cloud.request("mail:discardDraft", { draftId });
      onClose();
    } catch (cause) {
      setError(problem(cause));
    } finally {
      setBusy(false);
    }
  };
  const save = async (send: boolean) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const id = await cloud.request("mail:saveDraft", {
        accountId: account.id,
        ...(draftId ? { draftId } : {}),
        ...(replyTo
          ? { replyToMessageId: replyTo.id }
          : draft?.replyToMessageId
            ? { replyToMessageId: draft.replyToMessageId }
            : {}),
        to: to
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
        subject,
        text,
      });
      if (typeof id !== "string") throw new Error("The server did not confirm the draft.");
      setDraftId(id);
      if (send) {
        await cloud.request("mail:requestSend", { draftId: id });
        void cloud.relay("wake", { accountId: account.id }).catch(() => undefined);
        onClose();
      } else setNotice("Draft saved.");
    } catch (cause) {
      setError(problem(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label="Email draft">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{replyTo ? "Reply" : "Draft"}</h3>
        <Button size="xs" variant="ghost" disabled={busy} onClick={onClose}>
          Close
        </Button>
      </div>
      <label className="grid gap-1 text-xs">
        To
        <Input value={to} onChange={(event) => setTo(event.target.value)} disabled={locked} />
      </label>
      <label className="grid gap-1 text-xs">
        Subject
        <Input
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          disabled={locked}
        />
      </label>
      <label className="grid gap-1 text-xs">
        Message
        <Textarea
          rows={8}
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={locked}
        />
      </label>
      {error || draft?.lastError ? (
        <p role="alert" className="text-xs text-destructive">
          {error ?? draft?.lastError}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-xs">
          {notice}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {draft?.status === "unknown"
          ? "Delivery could not be confirmed. Check Gmail Sent before sending again."
          : locked
            ? `Delivery status: ${draft?.status}.`
            : "Mail is sent only when you press Send."}
      </p>
      <div className="flex justify-end gap-2">
        <Button
          className="mr-auto"
          size="sm"
          variant="outline"
          disabled={busy || locked}
          onClick={() => void discard()}
        >
          Discard draft
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || locked}
          onClick={() => void save(false)}
        >
          Save draft
        </Button>
        <Button
          size="sm"
          disabled={busy || locked || !to.trim() || !text.trim() || account.status !== "active"}
          onClick={() => void save(true)}
        >
          {busy ? "Saving…" : "Send"}
        </Button>
      </div>
    </section>
  );
}

function SaveSenderContact({
  cloud,
  message,
}: {
  cloud: ConnectedMailCloud;
  message: ConnectedMessage;
}) {
  const companies = useAtomValue(companyListAtom);
  const replicas = useAtomValue(companyRegistryReplicasAtom);
  const memberships = useAtomValue(companyRegistryMembershipIdsAtom);
  const [confirm, setConfirm] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [identity] = useState(() => ({ id: randomUUID(), requestId: randomUUID() }));
  const companyId = cloud.companyId;
  const canManage = companyId
    ? canManageContactsFromReplica(
        replicas.get(companyId)?.view.values() ?? [],
        memberships.get(companyId) ?? null,
      )
    : false;
  if (!canManage) return null;
  return (
    <div className="space-y-2">
      <Button variant="outline" size="xs" disabled={saved || busy} onClick={() => setConfirm(true)}>
        {saved ? "Contact saved" : "Save contact"}
      </Button>
      {confirm ? (
        <div className="rounded border p-3 text-xs">
          <p>
            Save {message.from.name ?? message.from.email} to{" "}
            {companies.find((item) => item.id === companyId)?.name ?? "this workspace"}? Members can
            read their name and email. Private sender notes will stay private.
          </p>
          <div className="mt-2 flex gap-2">
            <Button size="xs" variant="outline" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              size="xs"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(undefined);
                void cloud
                  .request("contacts:upsert", {
                    ...identity,
                    expectedRevision: null,
                    name: message.from.name ?? message.from.email,
                    role: "",
                    company: "",
                    email: message.from.email,
                    phone: "",
                    notes: "",
                    favorite: false,
                  })
                  .then(() => {
                    setSaved(true);
                    setConfirm(false);
                  })
                  .catch((cause: unknown) => setError(problem(cause)))
                  .finally(() => setBusy(false));
              }}
            >
              Save shared contact
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function MailReader({
  cloud,
  accounts,
  messageId,
  onSelect,
}: {
  cloud: ConnectedMailCloud;
  accounts: ConnectedMailAccount[];
  messageId: string;
  onSelect: (id: string) => void;
}) {
  const result = useMailQuery<ConnectedMessage | null>(
    cloud.client,
    cloud.scope,
    "mail:getMessage",
    { companyId: cloud.companyId!, messageId },
  );
  const message = result.value;
  const account = accounts.find((item) => item.id === message?.accountId);
  const sender = useMailQuery<{ summary: string; messageCount: number } | null>(
    cloud.client,
    cloud.scope,
    "mail:getSender",
    message
      ? { companyId: cloud.companyId!, accountId: message.accountId, email: message.from.email }
      : null,
  );
  const [threadCursors, setThreadCursors] = useState<string[]>([]);
  const thread = useMailQuery<MailPage>(
    cloud.client,
    cloud.scope,
    "mail:getThread",
    message
      ? {
          companyId: cloud.companyId!,
          accountId: message.accountId,
          providerThreadId: message.providerThreadId,
          ...(threadCursors.at(-1) ? { cursor: threadCursors.at(-1)! } : {}),
          limit: 50,
        }
      : null,
  );
  const [remote, setRemote] = useState(false);
  const [reply, setReply] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [body, setBody] = useState<{ htmlBody?: string; textBody?: string }>();
  const downloads = useRef(new Set<ReturnType<typeof beginMailAttachmentDownload>>());
  useEffect(() => {
    const activeDownloads = downloads.current;
    return () => {
      for (const download of activeDownloads) download.cancel();
      activeDownloads.clear();
    };
  }, [cloud.scope, messageId]);
  const htmlBody = body?.htmlBody ?? message?.htmlBody ?? null;
  const textBody = body?.textBody ?? message?.textBody ?? null;
  const preview = useMemo(
    () => buildEmailPreviewDocument({ htmlBody, textBody }, { allowRemoteContent: remote }),
    [htmlBody, textBody, remote],
  );
  useEffect(() => {
    if (!message || message.read) return;
    void cloud
      .request("mail:setRead", { messageId: message.id, read: true })
      .then(() => {
        void cloud.relay("wake", { accountId: message.accountId }).catch(() => undefined);
      })
      .catch((cause: unknown) => setError(problem(cause)));
    // Mark read once when opened; a later manual unread choice remains until reopening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message?.id]);
  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await operation();
    } catch (cause) {
      setError(problem(cause));
    } finally {
      setBusy(false);
    }
  };
  if (result.error)
    return (
      <p role="alert" className="p-5 text-sm text-destructive">
        {result.error}
      </p>
    );
  if (!message || !account)
    return (
      <p className="p-5 text-sm text-muted-foreground">
        {message === null ? "This message is unavailable." : "Loading message…"}
      </p>
    );
  return (
    <article className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 sm:p-6">
      <h1 className="text-lg font-semibold">{message.subject || "No subject"}</h1>
      <p className="mt-2 text-sm">
        {message.from.name ? `${message.from.name} <${message.from.email}>` : message.from.email}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {new Date(message.receivedAt).toLocaleString()} · {account.email}
      </p>
      <div className="my-4 rounded-lg bg-muted/40 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium capitalize">{message.bucket}</span>
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={() =>
              void run(() =>
                cloud.request("mail:setBucket", {
                  messageId,
                  bucket: message.bucket === "priority" ? "noise" : "priority",
                }),
              )
            }
          >
            {message.bucket === "noise" ? "Move to Priority" : "Move to Noise"}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {message.reason || "Waiting for analysis."}
        </p>
        {message.briefing ? (
          <p className="mt-3 whitespace-pre-wrap text-sm">{message.briefing}</p>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            {message.analysisStatus === "failed"
              ? "Analysis failed. Check the mailbox environment settings."
              : message.analysisStatus === "pending"
                ? "Analysis queued."
                : ""}
          </p>
        )}
      </div>
      {message.analysisStatus === "failed" ? (
        <Button
          className="mb-3 self-start"
          size="xs"
          variant="outline"
          disabled={busy || !account.brain}
          onClick={() => void run(() => cloud.request("mail:retryAnalysis", { messageId }))}
        >
          Retry analysis
        </Button>
      ) : null}
      {thread.value && (thread.value.messages.length > 1 || threadCursors.length > 0) ? (
        <details className="mb-4 text-xs">
          <summary>
            Conversation · {thread.value.messages.length}
            {thread.value.nextCursor ? "+" : ""} messages
          </summary>
          <div className="mt-2 space-y-1">
            {thread.value.messages.map((item) => (
              <button
                type="button"
                className="block w-full rounded p-2 text-left hover:bg-muted"
                key={item.id}
                onClick={() => onSelect(item.id)}
              >
                {item.from.name ?? item.from.email} · {new Date(item.receivedAt).toLocaleString()}
              </button>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={!threadCursors.length}
              onClick={() => setThreadCursors((current) => current.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!thread.value.nextCursor}
              onClick={() => {
                const cursor = thread.value?.nextCursor;
                if (cursor) setThreadCursors((current) => [...current, cursor]);
              }}
            >
              More messages
            </Button>
          </div>
        </details>
      ) : null}
      {message.bodyTruncated ? (
        <p className="mb-3 text-xs text-muted-foreground">
          This preview is incomplete.{" "}
          <a
            className="underline"
            href={gmailMessageUrl(account.email, message.providerMessageId)}
            target="_blank"
            rel="noreferrer"
          >
            View the full message in Gmail
          </a>
          .
        </p>
      ) : null}
      {message.attachments.some((item) => !item.blobKey) ? (
        <a
          className="mb-3 text-xs underline"
          href={gmailMessageUrl(account.email, message.providerMessageId)}
          target="_blank"
          rel="noreferrer"
        >
          Open Gmail to download unavailable attachments
        </a>
      ) : null}
      {message.bodyBlobKey && !body ? (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const { url } = await cloud.relay<{ url: string }>("download", {
                messageId,
                blobKey: message.bodyBlobKey!,
              });
              const response = await fetch(url, {
                credentials: "omit",
                referrerPolicy: "no-referrer",
              });
              if (!response.ok) throw new Error("Could not load the message body.");
              const value: unknown = await response.json();
              if (!value || typeof value !== "object") throw new Error("Invalid message body.");
              setBody({
                ...("htmlBody" in value && typeof value.htmlBody === "string"
                  ? { htmlBody: value.htmlBody }
                  : {}),
                ...("textBody" in value && typeof value.textBody === "string"
                  ? { textBody: value.textBody }
                  : {}),
              });
            })
          }
        >
          Load message body
        </Button>
      ) : (
        <>
          {!remote && hasRemoteEmailContent(htmlBody) ? (
            <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
              Remote images and styles are blocked.
              <Button size="xs" variant="outline" onClick={() => setRemote(true)}>
                Load remote content
              </Button>
            </div>
          ) : null}
          <iframe
            title={`Message: ${message.subject}`}
            className="min-h-96 w-full shrink-0 rounded border bg-white"
            sandbox={EMAIL_PREVIEW_SANDBOX}
            referrerPolicy="no-referrer"
            srcDoc={preview}
          />
        </>
      )}
      {message.attachments.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {message.attachments.map((attachment) => (
            <Button
              key={attachment.partId}
              size="xs"
              variant="outline"
              disabled={!attachment.blobKey || busy}
              onClick={() => {
                const download = beginMailAttachmentDownload({
                  openWindow: () => window.open("about:blank", "_blank"),
                  ...(window.desktopBridge
                    ? { openExternal: (url: string) => ensureLocalApi().shell.openExternal(url) }
                    : {}),
                  resolveUrl: async () => {
                    const { url } = await cloud.relay<{ url: string }>("download", {
                      messageId,
                      blobKey: attachment.blobKey!,
                    });
                    return url;
                  },
                });
                downloads.current.add(download);
                void run(async () => {
                  try {
                    await download.completed;
                  } finally {
                    downloads.current.delete(download);
                  }
                });
              }}
            >
              {attachment.filename} · {Math.ceil(attachment.size / 1024)} KB
            </Button>
          ))}
        </div>
      ) : null}
      <div className="my-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await cloud.request("mail:setRead", { messageId, read: !message.read });
              void cloud.relay("wake", { accountId: message.accountId }).catch(() => undefined);
            })
          }
        >
          {message.read ? "Mark unread" : "Mark read"}
        </Button>
        <Button size="sm" onClick={() => setReply(true)} disabled={account.status !== "active"}>
          Reply
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !account.brain || account.status !== "active"}
          onClick={() =>
            void run(async () => {
              await cloud.request("mail:requestDraft", { messageId });
              setNotice("A reply draft is queued. It will appear in Drafts after analysis.");
            })
          }
        >
          Draft reply with AI
        </Button>
        <SaveSenderContact key={message.from.email} cloud={cloud} message={message} />
      </div>
      {sender.value?.summary ? (
        <details className="mb-4 text-xs">
          <summary>Private sender knowledge · {sender.value.messageCount} messages</summary>
          <p className="mt-2 whitespace-pre-wrap text-sm">{sender.value.summary}</p>
        </details>
      ) : null}
      {notice ? (
        <p role="status" className="mb-3 text-xs">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mb-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {reply ? (
        <DraftEditor
          cloud={cloud}
          account={account}
          replyTo={message}
          onClose={() => setReply(false)}
        />
      ) : null}
    </article>
  );
}

export function ConnectedMailView({
  search,
  onSearch,
}: {
  search: EmailSearch;
  onSearch: (patch: EmailSearchPatch) => void;
}) {
  const cloud = useConnectedMailCloud();
  const accounts = useMailQuery<ConnectedMailAccount[]>(
    cloud.client,
    cloud.scope,
    "mail:listAccounts",
    cloud.ready ? { companyId: cloud.companyId! } : null,
  );
  const accountId = search.account;
  const bucket = search.bucket ?? "priority";
  const [cursors, setCursors] = useState<string[]>([]);
  const scope = `${cloud.scope}:${accountId ?? ""}:${bucket}`;
  const [pageScope, setPageScope] = useState(scope);
  const [draftId, setDraftId] = useState<string>();
  const [compose, setCompose] = useState(false);
  if (pageScope !== scope) {
    setPageScope(scope);
    setCursors([]);
    setDraftId(undefined);
    setCompose(false);
  }
  const cursor = pageScope === scope ? cursors.at(-1) : undefined;
  const page = useMailQuery<MailPage>(
    cloud.client,
    scope,
    "mail:listMessages",
    cloud.ready && bucket !== "drafts"
      ? {
          companyId: cloud.companyId!,
          ...(accountId ? { accountId } : {}),
          ...(bucket === "all" ? {} : { bucket }),
          ...(cursor ? { cursor } : {}),
          limit: 50,
        }
      : null,
  );
  const selectedAccount =
    accounts.value?.find((item) => item.id === accountId) ?? accounts.value?.[0];
  const drafts = useMailQuery<ConnectedDraft[]>(
    cloud.client,
    scope,
    "mail:listDrafts",
    cloud.ready && bucket === "drafts" && selectedAccount
      ? { companyId: cloud.companyId!, accountId: selectedAccount.id }
      : null,
  );

  const draft = drafts.value?.find((item) => item.id === draftId);
  return (
    <WorkspaceViewFrame
      title="Email"
      actions={
        <div className="no-drag flex gap-2">
          <Button
            size="xs"
            variant="outline"
            onClick={() => onSearch({ source: "capture", mailMessage: undefined })}
          >
            SMTP capture
          </Button>
          <Link
            to="/settings/email"
            className="rounded p-1.5 hover:bg-muted"
            aria-label="Email settings"
          >
            <SettingsIcon className="size-4" />
          </Link>
        </div>
      }
    >
      {!cloud.ready ? (
        <div className="m-auto max-w-sm p-6 text-center">
          <MailIcon className="mx-auto mb-3 size-7 text-muted-foreground" />
          <h2 className="font-medium">Connect your mail</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in and select a Pathway Connect workspace to read private mail.
          </p>
        </div>
      ) : accounts.error ? (
        <p role="alert" className="p-6 text-destructive">
          {accounts.error}
        </p>
      ) : accounts.value?.length === 0 ? (
        <div className="m-auto max-w-sm space-y-3 p-6 text-center">
          <h2 className="font-medium">Your inbox, with context</h2>
          <p className="text-sm text-muted-foreground">
            Connect Gmail to sort incoming messages and brief you on what needs attention.
          </p>
          <Link to="/settings/email" className="text-sm underline">
            Connect Gmail
          </Link>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b p-3">
            <select
              aria-label="Mail account"
              className="max-w-60 rounded border bg-background p-1.5 text-xs"
              value={accountId ?? ""}
              onChange={(event) =>
                onSearch({ account: event.target.value || undefined, mailMessage: undefined })
              }
            >
              <option value="">All accounts</option>
              {accounts.value?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.email}
                </option>
              ))}
            </select>
            <Button
              size="xs"
              disabled={!selectedAccount || selectedAccount.status !== "active"}
              onClick={() => setCompose(true)}
            >
              Compose
            </Button>
            {(["priority", "noise", "all", "drafts"] as const).map((value) => (
              <Button
                key={value}
                size="xs"
                variant={bucket === value ? "secondary" : "ghost"}
                aria-pressed={bucket === value}
                onClick={() => onSearch({ bucket: value, mailMessage: undefined })}
              >
                {value === "all" ? "All mail" : value.charAt(0).toUpperCase() + value.slice(1)}
              </Button>
            ))}
          </div>
          <div className="flex min-h-0 flex-1">
            <aside
              className={cn(
                "min-h-0 w-full flex-col overflow-y-auto border-r sm:flex sm:w-80 sm:shrink-0",
                search.mailMessage || draft || compose ? "hidden" : "flex",
              )}
            >
              {bucket === "drafts" ? (
                <>
                  {!accountId && selectedAccount ? (
                    <p className="p-3 text-xs text-muted-foreground">
                      Drafts for {selectedAccount.email}. Select an account to view its drafts.
                    </p>
                  ) : null}
                  {drafts.value?.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      onClick={() => {
                        setCompose(false);
                        setDraftId(item.id);
                      }}
                      className="border-b p-3 text-left hover:bg-muted"
                    >
                      <span className="block truncate text-sm">{item.subject || "No subject"}</span>
                      <span className="text-xs text-muted-foreground">
                        {item.status} · {item.to.join(", ")}
                      </span>
                    </button>
                  ))}
                  {drafts.value?.length === 0 ? (
                    <p className="p-5 text-sm text-muted-foreground">No drafts.</p>
                  ) : null}
                </>
              ) : (
                <>
                  {page.value?.messages.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      onClick={() => {
                        setCompose(false);
                        onSearch({ mailMessage: item.id });
                      }}
                      aria-current={item.id === search.mailMessage ? "true" : undefined}
                      className={cn(
                        "border-b p-3 text-left hover:bg-muted/60",
                        item.id === search.mailMessage && "bg-muted/60",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={cn("truncate text-sm", !item.read && "font-semibold")}>
                          {item.from.name ?? item.from.email}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {new Date(item.receivedAt).toLocaleDateString()}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-sm">{item.subject || "No subject"}</p>
                      <p className="mt-1 truncate text-xs text-muted-foreground">{item.snippet}</p>
                      <p className="mt-2 truncate text-[10px] text-muted-foreground">
                        <span className="capitalize">{item.bucket}</span> ·{" "}
                        {item.reason || "Waiting for analysis"}
                      </p>
                    </button>
                  ))}
                  {page.value?.messages.length === 0 ? (
                    <p className="p-5 text-sm text-muted-foreground">No messages in this view.</p>
                  ) : !page.value && !page.error ? (
                    <p className="p-5 text-sm text-muted-foreground">Loading mail…</p>
                  ) : null}
                  <div className="mt-auto flex justify-between gap-2 p-3">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!cursors.length}
                      onClick={() => {
                        setCursors((current) => current.slice(0, -1));
                        onSearch({ mailMessage: undefined });
                      }}
                    >
                      Previous
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!page.value?.nextCursor}
                      onClick={() => {
                        const next = page.value?.nextCursor;
                        if (next) {
                          setCursors((current) => [...current, next]);
                          onSearch({ mailMessage: undefined });
                        }
                      }}
                    >
                      Next
                    </Button>
                  </div>
                </>
              )}
              {page.error || drafts.error ? (
                <p role="alert" className="p-3 text-xs text-destructive">
                  {page.error ?? drafts.error}
                </p>
              ) : null}
            </aside>
            <div
              className={cn(
                "min-h-0 min-w-0 flex-1 flex-col",
                search.mailMessage || draft || compose ? "flex" : "hidden sm:flex",
              )}
            >
              {search.mailMessage || draft || compose ? (
                <Button
                  className="m-2 self-start sm:hidden"
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    onSearch({ mailMessage: undefined });
                    setDraftId(undefined);
                    setCompose(false);
                  }}
                >
                  <ArrowLeftIcon />
                  Back to messages
                </Button>
              ) : null}
              {compose && selectedAccount ? (
                <div className="overflow-auto p-4">
                  <p className="mb-3 text-xs text-muted-foreground">From {selectedAccount.email}</p>
                  <DraftEditor
                    key={`compose:${selectedAccount.id}`}
                    cloud={cloud}
                    account={selectedAccount}
                    onClose={() => setCompose(false)}
                  />
                </div>
              ) : bucket === "drafts" && draft && selectedAccount ? (
                <div className="overflow-auto p-4">
                  <DraftEditor
                    key={draft.id}
                    cloud={cloud}
                    account={selectedAccount}
                    draft={draft}
                    onClose={() =>
                      setDraftId((current) => (current === draft.id ? undefined : current))
                    }
                  />
                </div>
              ) : search.mailMessage && accounts.value ? (
                <MailReader
                  key={`${cloud.scope}:${search.mailMessage}`}
                  cloud={cloud}
                  accounts={accounts.value}
                  messageId={search.mailMessage}
                  onSelect={(id) => onSearch({ mailMessage: id })}
                />
              ) : (
                <p className="m-auto p-6 text-sm text-muted-foreground">
                  Select a message to read it.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </WorkspaceViewFrame>
  );
}
