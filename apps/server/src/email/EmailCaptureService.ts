// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import {
  CapturedEmailMessage as CapturedEmailMessageSchema,
  DEFAULT_EMAIL_CAPTURE_SETTINGS,
  EmailAttachmentId,
  EmailCaptureError,
  EmailMessageId,
  type CapturedEmailMessage,
  type EmailAnalyticsInput,
  type EmailAnalyticsResult,
  type EmailCaptureReceipt,
  type EmailCaptureSettings,
  type EmailClearInboxResult,
  type EmailGetResult,
  type EmailInboxScope,
  type EmailInboxSummary,
  type EmailListInput,
  type EmailListResult,
  type EmailListenerStatus,
  type EmailProjectSettings,
  type EmailReadStateResult,
  type EmailReadTarget,
  type EmailSettingsSnapshot,
  type EmailSmtpTransactionEntry,
  type EmailStreamEvent,
  type EmailWaitRegistration,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { SMTPServer, type SMTPServerSession } from "smtp-server";

import * as ServerSettings from "../serverSettings.ts";
import { analyzeEmailDeliverability } from "./DeliverabilityAnalyzer.ts";
import { EmailProjectCatalog } from "./EmailProjectCatalog.ts";
import { deriveMissingProjectSettings, routeEmail, validateUniqueMailSlugs } from "./Routing.ts";
import { detectTwoFactorCode } from "./detectTwoFactorCode.ts";
import { EmailStore, type EmailAttachmentFile } from "./EmailStore.ts";
import { EmailWaitStore } from "./EmailWaitStore.ts";

const MAX_LIST_LIMIT = 200;

export interface CaptureEmailInput {
  readonly message: Omit<CapturedEmailMessage, "detectedCode" | "isRead" | "deliverability">;
  readonly raw: Uint8Array;
  readonly attachments: ReadonlyArray<EmailAttachmentFile>;
  readonly projectSettings?: EmailProjectSettings | null;
  /** Trusted provenance when capture is invoked by a Pathway-managed agent run. */
  readonly originatingThreadId?: ThreadId;
}

export interface EmailStoredReceipt {
  readonly message: CapturedEmailMessage;
  readonly completedWaits: ReadonlyArray<EmailWaitRegistration>;
  readonly originatingThreadId?: ThreadId;
}

export interface EmailCaptureServiceShape {
  readonly start: Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
  readonly capture: (
    input: CaptureEmailInput,
  ) => Effect.Effect<EmailStoredReceipt, EmailCaptureError>;
  readonly list: (input: EmailListInput) => Effect.Effect<EmailListResult, EmailCaptureError>;
  readonly get: (
    messageId: CapturedEmailMessage["id"],
  ) => Effect.Effect<EmailGetResult, EmailCaptureError>;
  readonly analytics: (
    input: EmailAnalyticsInput,
  ) => Effect.Effect<EmailAnalyticsResult, EmailCaptureError>;
  readonly markRead: (
    target: EmailReadTarget,
    isRead: boolean,
  ) => Effect.Effect<EmailReadStateResult, EmailCaptureError>;
  readonly clearInbox: (
    scope: EmailInboxScope,
  ) => Effect.Effect<EmailClearInboxResult, EmailCaptureError>;
  readonly getSettings: Effect.Effect<EmailSettingsSnapshot, EmailCaptureError>;
  readonly updateSettings: (
    settings: EmailCaptureSettings,
  ) => Effect.Effect<EmailSettingsSnapshot, EmailCaptureError>;
  readonly status: Effect.Effect<EmailListenerStatus>;
  readonly stream: Stream.Stream<EmailStreamEvent>;
  readonly stored: Stream.Stream<EmailStoredReceipt>;
  readonly receipts: Stream.Stream<EmailCaptureReceipt>;
  readonly subscribeReceipts: Effect.Effect<Stream.Stream<EmailCaptureReceipt>, never, Scope.Scope>;
}

export class EmailCaptureService extends Context.Service<
  EmailCaptureService,
  EmailCaptureServiceShape
>()("t3/email/EmailCaptureService") {}

const captureError = (reason: EmailCaptureError["reason"], message: string) =>
  new EmailCaptureError({ reason, message });

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const nowIso = (): string => new Date().toISOString();

const smtpEntry = (
  direction: EmailSmtpTransactionEntry["direction"],
  line: string,
): EmailSmtpTransactionEntry => ({ at: nowIso(), direction, line });

const addressValues = (value: AddressObject | ReadonlyArray<AddressObject> | undefined) => {
  const objects = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return objects
    .flatMap((object) => object.value)
    .flatMap((address) => {
      if (!address.address?.trim()) return [];
      return [{ address: address.address.trim(), name: address.name?.trim() || null }];
    });
};

const parsedHeaders = (mail: ParsedMail) => ({
  subject: mail.subject ?? null,
  messageId: mail.messageId?.trim() || null,
  date:
    mail.date !== undefined && Number.isFinite(mail.date.getTime())
      ? mail.date.toISOString()
      : null,
  from: addressValues(mail.from),
  to: addressValues(mail.to),
  cc: addressValues(mail.cc),
  bcc: addressValues(mail.bcc),
  replyTo: addressValues(mail.replyTo),
  headers: mail.headerLines.flatMap(({ key, line }) => {
    const name = key.trim();
    if (!name) return [];
    const separator = line.indexOf(":");
    return [{ name, value: separator < 0 ? line : line.slice(separator + 1).trimStart() }];
  }),
});

const emptyParsedMail = (raw: Uint8Array): ParsedMail =>
  ({
    attachments: [],
    headers: new Map(),
    headerLines: [],
    html: false,
    text: new TextDecoder().decode(raw),
  }) as ParsedMail;

const decodeCapturedMessage = Schema.decodeUnknownEffect(CapturedEmailMessageSchema);

const make = Effect.fn("EmailCaptureService.make")(function* () {
  const store = yield* EmailStore;
  const waits = yield* EmailWaitStore;
  const projects = yield* EmailProjectCatalog;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const events = yield* PubSub.sliding<EmailStreamEvent>(256);
  const storedEvents = yield* PubSub.sliding<EmailStoredReceipt>(256);
  const receiptEvents = yield* PubSub.sliding<EmailCaptureReceipt>(256);
  const listener = yield* Ref.make<SMTPServer | null>(null);
  const listenerStatus = yield* Ref.make<EmailListenerStatus>({
    state: "disabled",
    bindAddress: DEFAULT_EMAIL_CAPTURE_SETTINGS.listener.bindAddress,
    port: DEFAULT_EMAIL_CAPTURE_SETTINGS.listener.port,
    error: null,
  });
  const appliedListenerKey = yield* Ref.make("");
  const transactionLogs = new Map<string, EmailSmtpTransactionEntry[]>();

  const readSettings = Effect.fn("EmailCaptureService.readSettings")(function* () {
    const current = yield* serverSettings.getSettings.pipe(
      Effect.mapError((cause) => captureError("storage", cause.message)),
    );
    const catalog = yield* projects.list.pipe(
      Effect.mapError((cause) => captureError("storage", errorText(cause))),
    );
    const derived = deriveMissingProjectSettings({
      projects: catalog,
      configured: current.emailCapture.projects,
    });
    if (derived.length === current.emailCapture.projects.length) return current.emailCapture;
    const updated = yield* serverSettings
      .updateSettings({
        emailCapture: { ...current.emailCapture, projects: derived },
      })
      .pipe(Effect.mapError((cause) => captureError("storage", cause.message)));
    return updated.emailCapture;
  });

  const inboxes = Effect.fn("EmailCaptureService.inboxes")(function* (
    settings?: EmailCaptureSettings,
  ) {
    const resolved = settings ?? (yield* readSettings());
    const messages = yield* store.allMessages;
    const makeInbox = (
      scope: EmailInboxScope,
      name: string,
      mailSlug: EmailInboxSummary["mailSlug"],
      toastMuted: boolean,
    ): EmailInboxSummary => {
      const scoped = messages.filter(
        (message) =>
          scope.type === "all" ||
          (scope.type === "unassigned"
            ? message.attribution.projectId === null
            : message.attribution.projectId === scope.projectId),
      );
      return {
        scope,
        name,
        mailSlug,
        messageCount: scoped.length,
        unreadCount: scoped.filter((message) => !message.isRead).length,
        toastMuted,
      };
    };
    return [
      makeInbox({ type: "all" }, "All mail", null, false),
      ...resolved.projects.map((project) =>
        makeInbox(
          { type: "project", projectId: project.projectId },
          project.mailSlug,
          project.mailSlug,
          project.toastMuted,
        ),
      ),
      makeInbox({ type: "unassigned" }, "Unassigned", null, false),
    ];
  });

  const capture: EmailCaptureServiceShape["capture"] = Effect.fn("EmailCaptureService.capture")(
    function* (input) {
      const detectedCode = detectTwoFactorCode({
        subject: input.message.parsedHeaders.subject,
        textBody: input.message.textBody,
        htmlBody: input.message.htmlBody,
        projectRegex: input.projectSettings?.twoFactorCodeRegex ?? null,
      });
      const message = yield* decodeCapturedMessage({
        ...input.message,
        isRead: false,
        detectedCode,
        deliverability: analyzeEmailDeliverability(input.message),
      }).pipe(Effect.mapError(() => captureError("invalid", "Captured email is invalid.")));
      const files = yield* store.writeFiles(message.id, input.raw, input.attachments);
      yield* store.insert(message, files);
      const completedWaits = yield* waits.completeMatching(message);
      const settings = yield* readSettings();
      const evictedMessageIds = yield* store.applyRetention({
        policy: settings.retention,
        projects: settings.projects,
        nowMs: Date.now(),
      });
      const allInboxes = yield* inboxes(settings);
      const storedReceipt = {
        message,
        completedWaits,
        ...(input.originatingThreadId === undefined
          ? {}
          : { originatingThreadId: input.originatingThreadId }),
      } satisfies EmailStoredReceipt;
      yield* PubSub.publish(storedEvents, storedReceipt);
      yield* PubSub.publish(receiptEvents, {
        _tag: "EmailMessageStored",
        messageId: message.id,
        attribution: message.attribution,
        storedAt: message.timings.storedAt,
        evictedMessageIds,
      });
      yield* PubSub.publish(events, {
        _tag: "EmailCaptured",
        message: {
          id: message.id,
          attribution: message.attribution,
          from: message.parsedHeaders.from,
          to: message.parsedHeaders.to,
          subject: message.parsedHeaders.subject,
          textPreview: (message.textBody ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
          receivedAt: message.timings.messageReceivedAt,
          sizeBytes: message.sizeBytes,
          attachmentCount: message.attachments.length,
          isRead: false,
          detectedCode: message.detectedCode,
        },
        detectedCode: message.detectedCode,
        inboxes: allInboxes,
      });
      return storedReceipt;
    },
  );

  const captureRaw = Effect.fn("EmailCaptureService.captureRaw")(function* (
    raw: Uint8Array,
    session: SMTPServerSession,
  ) {
    const connectedAt = transactionLogs.get(session.id)?.[0]?.at ?? nowIso();
    const messageReceivedAt = nowIso();
    const parseStartedAt = Date.now();
    const mail = yield* Effect.tryPromise({
      // Preserve MIME-part presence for deliverability checks. mailparser otherwise synthesizes
      // text from HTML (and HTML from text), which would hide a missing multipart alternative.
      try: () => simpleParser(Buffer.from(raw), { skipHtmlToText: true, skipTextToHtml: true }),
      catch: () => captureError("invalid", "Could not parse MIME message."),
    }).pipe(Effect.catchAll(() => Effect.succeed(emptyParsedMail(raw))));
    const parsedAtMs = Date.now();
    const parsedAt = new Date(parsedAtMs).toISOString();
    const settings = yield* readSettings();
    const recipients = session.envelope.rcptTo.map(({ address }) => address);
    const attribution = routeEmail({
      authUsername: typeof session.user === "string" ? session.user : null,
      recipients,
      projects: settings.projects,
    });
    const messageId = EmailMessageId.make(randomUUID());
    const attachmentFiles: EmailAttachmentFile[] = mail.attachments.map((attachment) => {
      const metadata = {
        id: EmailAttachmentId.make(randomUUID()),
        filename: attachment.filename ?? null,
        contentType: attachment.contentType || "application/octet-stream",
        contentDisposition: attachment.contentDisposition || null,
        contentId: attachment.contentId ?? attachment.cid ?? null,
        sizeBytes: attachment.content.byteLength,
      };
      return { attachment: metadata, content: attachment.content };
    });
    const storedAt = nowIso();
    const projectSettings = settings.projects.find(
      ({ projectId }) => projectId === attribution.projectId,
    );
    return yield* capture({
      message: {
        id: messageId,
        attribution,
        envelope: {
          mailFrom: session.envelope.mailFrom === false ? null : session.envelope.mailFrom.address,
          rcptTo: recipients,
          authUsername: typeof session.user === "string" ? session.user : null,
          helo: session.hostNameAppearsAs?.trim() || null,
          remoteAddress: session.remoteAddress?.trim() || null,
        },
        parsedHeaders: parsedHeaders(mail),
        textBody: mail.text ?? null,
        htmlBody: mail.html === false ? null : mail.html,
        attachments: attachmentFiles.map(({ attachment }) => attachment),
        smtpTransactionLog: transactionLogs.get(session.id) ?? [],
        timings: {
          connectedAt,
          messageReceivedAt,
          parsedAt,
          storedAt,
          parseDurationMs: Math.max(0, parsedAtMs - parseStartedAt),
          totalDurationMs: Math.max(0, Date.parse(storedAt) - Date.parse(connectedAt)),
        },
        sizeBytes: raw.byteLength,
      },
      raw,
      attachments: attachmentFiles,
      projectSettings,
    });
  });

  const makeSmtpServer = () =>
    new SMTPServer({
      name: "Pathway local SMTP capture",
      banner: "Messages are captured locally and are never relayed.",
      secure: false,
      authOptional: true,
      authMethods: ["PLAIN", "LOGIN"],
      allowInsecureAuth: true,
      disableReverseLookup: true,
      logger: false,
      onConnect(session, callback) {
        transactionLogs.set(session.id, [smtpEntry("server", "220 Pathway local SMTP capture")]);
        callback();
      },
      onAuth(auth, session, callback) {
        const username = auth.username?.trim() || "unassigned";
        session.user = username;
        transactionLogs
          .get(session.id)
          ?.push(
            smtpEntry("client", `AUTH ${auth.method} ${username}`),
            smtpEntry("server", "235 Authentication successful"),
          );
        callback(null, { user: username });
      },
      onMailFrom(address, session, callback) {
        transactionLogs
          .get(session.id)
          ?.push(smtpEntry("client", `MAIL FROM:<${address.address}>`));
        callback();
      },
      onRcptTo(address, session, callback) {
        transactionLogs.get(session.id)?.push(smtpEntry("client", `RCPT TO:<${address.address}>`));
        callback();
      },
      onData(stream, session, callback) {
        const chunks: Buffer[] = [];
        let finished = false;
        const finish = (cause?: Error | null, message?: string) => {
          if (finished) return;
          finished = true;
          callback(cause, message);
        };
        transactionLogs.get(session.id)?.push(smtpEntry("client", "DATA"));
        stream.on("data", (chunk: Buffer | Uint8Array | string) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        stream.once("error", (cause) => finish(cause));
        stream.once("end", () => {
          transactionLogs.get(session.id)?.push(smtpEntry("server", "250 Message captured"));
          void Effect.runPromise(captureRaw(Buffer.concat(chunks), session)).then(
            () => finish(null, "Message captured"),
            (cause) => {
              const message = errorText(cause);
              void Effect.runPromise(
                PubSub.publish(receiptEvents, {
                  _tag: "EmailCaptureFailed",
                  failedAt: nowIso(),
                  message,
                }),
              );
              finish(new Error(message));
            },
          );
        });
      },
      onClose(session, callback) {
        transactionLogs.delete(session.id);
        callback();
      },
    });

  const publishStatus = Effect.fn("EmailCaptureService.publishStatus")(function* (
    status: EmailListenerStatus,
  ) {
    yield* Ref.set(listenerStatus, status);
    yield* PubSub.publish(receiptEvents, {
      _tag: "EmailListenerChanged",
      changedAt: nowIso(),
      status,
    });
  });

  const stop = Effect.gen(function* () {
    const current = yield* Ref.getAndSet(listener, null);
    if (current === null) return;
    yield* Effect.callback<void>((resume) => current.close(() => resume(Effect.void)));
  });

  const applyListener = Effect.fn("EmailCaptureService.applyListener")(function* (
    settings: EmailCaptureSettings,
  ) {
    const key = JSON.stringify(settings.listener);
    yield* Ref.set(appliedListenerKey, key);
    yield* stop;
    if (!settings.listener.enabled) {
      yield* publishStatus({
        state: "disabled",
        bindAddress: settings.listener.bindAddress,
        port: settings.listener.port,
        error: null,
      });
      return;
    }
    const smtp = makeSmtpServer();
    yield* Ref.set(listener, smtp);
    yield* Effect.callback<void>((resume) => {
      let settled = false;
      const finish = (effect: Effect.Effect<void>) => {
        if (settled) return;
        settled = true;
        resume(effect);
      };
      smtp.once("error", (cause) => {
        const message =
          (cause as NodeJS.ErrnoException).code === "EADDRINUSE"
            ? `SMTP capture could not bind ${settings.listener.bindAddress}:${settings.listener.port}: the port is already in use.`
            : `SMTP capture listener failed: ${cause.message}`;
        finish(
          Ref.set(listener, null).pipe(
            Effect.andThen(
              publishStatus({
                state: "error",
                bindAddress: settings.listener.bindAddress,
                port: settings.listener.port,
                error: message,
              }),
            ),
          ),
        );
      });
      smtp.listen(settings.listener.port, settings.listener.bindAddress, () => {
        const address = smtp.server.address() as AddressInfo | null;
        finish(
          publishStatus({
            state: "listening",
            bindAddress: settings.listener.bindAddress,
            port: address?.port ?? settings.listener.port,
            error: null,
          }),
        );
      });
    });
  });

  const start = Effect.gen(function* () {
    const settings = yield* readSettings().pipe(
      Effect.catchAll((cause) =>
        publishStatus({
          state: "error",
          bindAddress: DEFAULT_EMAIL_CAPTURE_SETTINGS.listener.bindAddress,
          port: DEFAULT_EMAIL_CAPTURE_SETTINGS.listener.port,
          error: cause.message,
        }).pipe(Effect.as(DEFAULT_EMAIL_CAPTURE_SETTINGS)),
      ),
    );
    yield* applyListener(settings);
    yield* Stream.runForEach(serverSettings.streamChanges, (next) =>
      Effect.gen(function* () {
        const key = JSON.stringify(next.emailCapture.listener);
        if (key === (yield* Ref.get(appliedListenerKey))) return;
        yield* applyListener(next.emailCapture);
        const snapshot = {
          settings: next.emailCapture,
          listenerStatus: yield* Ref.get(listenerStatus),
        };
        yield* PubSub.publish(events, { _tag: "EmailSettingsChanged", snapshot });
      }).pipe(
        Effect.catchAll((cause) =>
          Effect.logWarning("Could not apply SMTP capture settings", { cause }),
        ),
      ),
    ).pipe(Effect.forkScoped);
  });

  yield* Effect.addFinalizer(() => stop);

  const list: EmailCaptureServiceShape["list"] = Effect.fn("EmailCaptureService.list")(
    function* (input) {
      const stored = yield* store.list({
        ...input,
        limit: Math.min(input.limit ?? 50, MAX_LIST_LIMIT),
      });
      return { ...stored, inboxes: yield* inboxes() };
    },
  );

  const get: EmailCaptureServiceShape["get"] = Effect.fn("EmailCaptureService.get")(
    function* (messageId) {
      const message = yield* store.getMessage(messageId);
      if (message === null)
        return yield* new EmailCaptureError({
          reason: "not-found",
          message: "Captured email was not found.",
          messageId,
        });
      return { message };
    },
  );

  const markRead: EmailCaptureServiceShape["markRead"] = Effect.fn("EmailCaptureService.markRead")(
    function* (target, isRead) {
      const updatedMessageIds = yield* store.setRead(
        target.type === "message" ? target : target.scope,
        isRead,
      );
      const allInboxes = yield* inboxes();
      yield* PubSub.publish(events, {
        _tag: "EmailReadStateChanged",
        messageIds: updatedMessageIds,
        isRead,
        inboxes: allInboxes,
      });
      return { updatedMessageIds, inboxes: allInboxes };
    },
  );

  const clearInbox: EmailCaptureServiceShape["clearInbox"] = Effect.fn(
    "EmailCaptureService.clearInbox",
  )(function* (scope) {
    const clearedMessageIds = yield* store.clear(scope);
    const allInboxes = yield* inboxes();
    yield* PubSub.publish(events, {
      _tag: "EmailInboxCleared",
      scope,
      clearedCount: clearedMessageIds.length,
      inboxes: allInboxes,
    });
    yield* PubSub.publish(receiptEvents, {
      _tag: "EmailInboxClearCompleted",
      completedAt: nowIso(),
      scope,
      clearedMessageIds,
    });
    return { clearedCount: clearedMessageIds.length, inboxes: allInboxes };
  });

  const getSettings = Effect.all({
    settings: readSettings(),
    listenerStatus: Ref.get(listenerStatus),
  });

  const updateSettings: EmailCaptureServiceShape["updateSettings"] = Effect.fn(
    "EmailCaptureService.updateSettings",
  )(function* (settings) {
    const collision = validateUniqueMailSlugs(settings.projects);
    if (collision !== null)
      return yield* captureError(
        "conflict",
        `Mail slug '${collision.slug}' is assigned to more than one project.`,
      );
    const updated = yield* serverSettings
      .updateSettings({ emailCapture: settings })
      .pipe(Effect.mapError((cause) => captureError("storage", cause.message)));
    yield* applyListener(updated.emailCapture);
    const snapshot = {
      settings: updated.emailCapture,
      listenerStatus: yield* Ref.get(listenerStatus),
    };
    yield* PubSub.publish(events, { _tag: "EmailSettingsChanged", snapshot });
    return snapshot;
  });

  return EmailCaptureService.of({
    start,
    stop,
    capture,
    list,
    get,
    analytics: store.analytics,
    markRead,
    clearInbox,
    getSettings,
    updateSettings,
    status: Ref.get(listenerStatus),
    stream: Stream.fromPubSub(events),
    stored: Stream.fromPubSub(storedEvents),
    receipts: Stream.fromPubSub(receiptEvents),
    subscribeReceipts: PubSub.subscribe(receiptEvents).pipe(Effect.map(Stream.fromSubscription)),
  });
});

export const layer = Layer.effect(EmailCaptureService, make());
