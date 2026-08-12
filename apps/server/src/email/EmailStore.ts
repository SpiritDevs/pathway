// @effect-diagnostics nodeBuiltinImport:off
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  CapturedEmailMessage as CapturedEmailMessageSchema,
  EmailAnalyticsResult as EmailAnalyticsResultSchema,
  EmailCaptureError,
  type CapturedEmailMessage,
  type CapturedEmailSummary,
  type EmailAnalyticsInput,
  type EmailAnalyticsResult,
  type EmailAttachment,
  type EmailInboxScope,
  type EmailListFilters,
  type EmailMessageId,
  type EmailProjectSettings,
  type EmailRetentionPolicy,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { ServerConfig } from "../config.ts";
import { analyzeEmailDeliverability } from "./DeliverabilityAnalyzer.ts";

export const DEFAULT_EMAIL_ANALYTICS_ADDRESS_LIMIT = 10;
export const MAX_EMAIL_ANALYTICS_ADDRESS_LIMIT = 100;

export type CapturedEmailMessageInput = Omit<CapturedEmailMessage, "deliverability">;

export interface EmailAttachmentFile {
  readonly attachment: EmailAttachment;
  readonly content: Uint8Array;
}

export interface EmailStoredFiles {
  readonly rawRelativePath: string;
  readonly attachments: ReadonlyArray<{
    readonly attachment: EmailAttachment;
    readonly relativePath: string;
  }>;
}

export interface EmailStoredList {
  readonly messages: ReadonlyArray<CapturedEmailSummary>;
  readonly nextCursor: string | null;
}

export interface EmailStoreShape {
  readonly capture: (
    message: CapturedEmailMessageInput,
  ) => Effect.Effect<CapturedEmailMessage, EmailCaptureError>;
  readonly writeFiles: (
    messageId: EmailMessageId,
    raw: Uint8Array,
    attachments: ReadonlyArray<EmailAttachmentFile>,
  ) => Effect.Effect<EmailStoredFiles, EmailCaptureError>;
  readonly insert: (
    message: CapturedEmailMessage,
    files: EmailStoredFiles,
  ) => Effect.Effect<void, EmailCaptureError>;
  readonly getMessage: (
    messageId: EmailMessageId,
  ) => Effect.Effect<CapturedEmailMessage | null, EmailCaptureError>;
  readonly list: (input: {
    readonly scope: EmailInboxScope;
    readonly cursor?: string;
    readonly limit: number;
    readonly filters?: EmailListFilters;
  }) => Effect.Effect<EmailStoredList, EmailCaptureError>;
  readonly setRead: (
    scope: EmailInboxScope | { readonly type: "message"; readonly messageId: EmailMessageId },
    isRead: boolean,
  ) => Effect.Effect<ReadonlyArray<EmailMessageId>, EmailCaptureError>;
  readonly clear: (
    scope: EmailInboxScope,
  ) => Effect.Effect<ReadonlyArray<EmailMessageId>, EmailCaptureError>;
  readonly applyRetention: (input: {
    readonly policy: EmailRetentionPolicy;
    readonly projects: ReadonlyArray<EmailProjectSettings>;
    readonly nowMs: number;
  }) => Effect.Effect<ReadonlyArray<EmailMessageId>, EmailCaptureError>;
  readonly allMessages: Effect.Effect<ReadonlyArray<CapturedEmailMessage>, EmailCaptureError>;
  readonly analytics: (
    input: EmailAnalyticsInput,
  ) => Effect.Effect<EmailAnalyticsResult, EmailCaptureError>;
}

export class EmailStore extends Context.Service<EmailStore, EmailStoreShape>()(
  "t3/email/EmailStore",
) {}

interface MessagePayloadRow {
  readonly id: string;
  readonly project_id: string | null;
  readonly mail_slug: string | null;
  readonly stored_at: string;
  readonly is_read: number;
  readonly raw_relative_path: string;
  readonly payload_json: string;
}

interface AttachmentPathRow {
  readonly relative_path: string;
}

interface CountRow {
  readonly message_count: number;
}
interface VolumeRow extends CountRow {
  readonly bucket_start: string;
}
interface ProjectCountRow extends CountRow {
  readonly project_id: string | null;
  readonly mail_slug: string | null;
}
interface AddressCountRow extends CountRow {
  readonly address: string;
}
interface LatencyRow {
  readonly total_duration_ms: number;
}

interface RuntimeStatement {
  readonly all: (...parameters: ReadonlyArray<unknown>) => ReadonlyArray<unknown>;
  readonly get: (...parameters: ReadonlyArray<unknown>) => unknown;
  readonly run: (...parameters: ReadonlyArray<unknown>) => { readonly changes: number | bigint };
}

interface RuntimeDatabase {
  readonly close: () => void;
  readonly exec: (sql: string) => unknown;
  readonly prepare: (sql: string) => RuntimeStatement;
}

const importRuntimeModule = (specifier: string): Promise<unknown> =>
  Function("specifier", "return import(specifier)")(specifier) as Promise<unknown>;

const storageError = (operation: string, cause: unknown) =>
  new EmailCaptureError({
    reason: "storage",
    message: `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const invalidAnalyticsInput = (message: string) =>
  new EmailCaptureError({ reason: "invalid", message });

const openRuntimeDatabase = async (databasePath: string): Promise<RuntimeDatabase> => {
  if (process.versions.bun !== undefined) {
    const { Database } = (await importRuntimeModule("bun:sqlite")) as {
      readonly Database: new (
        filename: string,
        options: { readonly create: boolean },
      ) => RuntimeDatabase;
    };
    return new Database(databasePath, { create: true }) as unknown as RuntimeDatabase;
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(databasePath) as unknown as RuntimeDatabase;
};

const initializeDatabase = (database: RuntimeDatabase): void => {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS email_messages (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      mail_slug TEXT,
      matched_by TEXT NOT NULL,
      matched_value TEXT,
      received_at TEXT NOT NULL,
      stored_at TEXT NOT NULL,
      total_duration_ms INTEGER NOT NULL CHECK (total_duration_ms >= 0),
      is_read INTEGER NOT NULL DEFAULT 0,
      raw_relative_path TEXT NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS email_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
      filename TEXT,
      content_type TEXT NOT NULL,
      content_disposition TEXT,
      content_id TEXT,
      size_bytes INTEGER NOT NULL,
      relative_path TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS email_message_addresses (
      message_id TEXT NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('sender', 'recipient')),
      address TEXT NOT NULL,
      PRIMARY KEY (message_id, kind, address)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS email_messages_inbox_received_idx
      ON email_messages(project_id, received_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS email_messages_read_idx
      ON email_messages(project_id, is_read, received_at DESC);
    CREATE INDEX IF NOT EXISTS email_attachments_message_idx
      ON email_attachments(message_id);
    CREATE INDEX IF NOT EXISTS email_message_addresses_kind_address_idx
      ON email_message_addresses(kind, address, message_id);
  `);
};

const normalizeAddresses = (addresses: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(addresses.map((address) => address.trim().toLowerCase()).filter(Boolean))].sort();

const senderAddresses = (message: CapturedEmailMessage): ReadonlyArray<string> =>
  normalizeAddresses(message.parsedHeaders.from.map((address) => address.address));

const recipientAddresses = (message: CapturedEmailMessage): ReadonlyArray<string> =>
  normalizeAddresses([
    ...message.envelope.rcptTo,
    ...message.parsedHeaders.to.map((address) => address.address),
    ...message.parsedHeaders.cc.map((address) => address.address),
    ...message.parsedHeaders.bcc.map((address) => address.address),
  ]);

const summaryOf = (message: CapturedEmailMessage): CapturedEmailSummary => ({
  id: message.id,
  attribution: message.attribution,
  from: message.parsedHeaders.from,
  to: message.parsedHeaders.to,
  subject: message.parsedHeaders.subject,
  textPreview: (message.textBody ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
  receivedAt: message.timings.messageReceivedAt,
  sizeBytes: message.sizeBytes,
  attachmentCount: message.attachments.length,
  isRead: message.isRead,
  detectedCode: message.detectedCode,
});

const matchesScope = (row: MessagePayloadRow, scope: EmailInboxScope): boolean =>
  scope.type === "all" ||
  (scope.type === "unassigned" ? row.project_id === null : row.project_id === scope.projectId);

const includesText = (value: string | null, needle: string | undefined): boolean =>
  needle === undefined || (value ?? "").toLowerCase().includes(needle.toLowerCase());

const matchesFilters = (message: CapturedEmailMessage, filters?: EmailListFilters): boolean =>
  filters === undefined ||
  (includesText(
    [
      ...message.parsedHeaders.from.map(({ address }) => address),
      message.envelope.mailFrom ?? "",
    ].join(" "),
    filters.sender,
  ) &&
    includesText(message.parsedHeaders.subject, filters.subject) &&
    includesText(
      [...message.envelope.rcptTo, ...message.parsedHeaders.to.map(({ address }) => address)].join(
        " ",
      ),
      filters.recipient,
    ) &&
    (filters.isRead === undefined || message.isRead === filters.isRead));

const decodeMessage = (row: MessagePayloadRow): CapturedEmailMessage =>
  Schema.decodeUnknownSync(CapturedEmailMessageSchema)({
    ...JSON.parse(row.payload_json),
    isRead: row.is_read === 1,
  });

interface AnalyticsFilters {
  readonly whereSql: string;
  readonly parameters: ReadonlyArray<unknown>;
}

const analyticsFilters = (input: EmailAnalyticsInput): AnalyticsFilters => {
  const conditions: string[] = [];
  const parameters: unknown[] = [];
  if (input.scope.type === "project") {
    conditions.push("m.project_id = ?");
    parameters.push(input.scope.projectId);
  } else if (input.scope.type === "unassigned") {
    conditions.push("m.project_id IS NULL");
  }
  if (input.from !== undefined) {
    conditions.push("m.received_at >= ?");
    parameters.push(input.from);
  }
  if (input.to !== undefined) {
    conditions.push("m.received_at < ?");
    parameters.push(input.to);
  }
  return {
    whereSql: conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`,
    parameters,
  };
};

const queryRows = <Row>(
  database: RuntimeDatabase,
  sql: string,
  parameters: ReadonlyArray<unknown>,
) => database.prepare(sql).all(...parameters) as unknown as ReadonlyArray<Row>;

const nearestRank = (values: ReadonlyArray<number>, percentile: number): number =>
  values.length === 0 ? 0 : (values[Math.max(0, Math.ceil(percentile * values.length) - 1)] ?? 0);

const queryAnalytics = (
  database: RuntimeDatabase,
  input: EmailAnalyticsInput,
): EmailAnalyticsResult => {
  const { whereSql, parameters } = analyticsFilters(input);
  const bucket =
    input.interval === "hour"
      ? "strftime('%Y-%m-%dT%H:00:00.000Z', m.received_at)"
      : "strftime('%Y-%m-%dT00:00:00.000Z', m.received_at)";
  const addressLimit = Math.min(
    input.topAddressLimit ?? DEFAULT_EMAIL_ANALYTICS_ADDRESS_LIMIT,
    MAX_EMAIL_ANALYTICS_ADDRESS_LIMIT,
  );
  const volume = queryRows<VolumeRow>(
    database,
    `SELECT ${bucket} bucket_start, COUNT(*) message_count FROM email_messages m ${whereSql} GROUP BY bucket_start ORDER BY bucket_start`,
    parameters,
  );
  const projects = queryRows<ProjectCountRow>(
    database,
    `SELECT m.project_id, m.mail_slug, COUNT(*) message_count FROM email_messages m ${whereSql} GROUP BY m.project_id, m.mail_slug ORDER BY message_count DESC, COALESCE(m.mail_slug, '')`,
    parameters,
  );
  const addresses = (kind: "sender" | "recipient") =>
    queryRows<AddressCountRow>(
      database,
      `SELECT a.address, COUNT(*) message_count FROM email_message_addresses a JOIN email_messages m ON m.id = a.message_id ${whereSql.length === 0 ? "WHERE" : `${whereSql} AND`} a.kind = ? GROUP BY a.address ORDER BY message_count DESC, a.address LIMIT ?`,
      [...parameters, kind, addressLimit],
    );
  const latencies = queryRows<LatencyRow>(
    database,
    `SELECT m.total_duration_ms FROM email_messages m ${whereSql} ORDER BY m.total_duration_ms`,
    parameters,
  ).map((row) => Number(row.total_duration_ms));
  return Schema.decodeUnknownSync(EmailAnalyticsResultSchema)({
    volumeOverTime: volume.map((row) => ({
      bucketStart: row.bucket_start,
      messageCount: Number(row.message_count),
    })),
    perProjectCounts: projects.map((row) => ({
      projectId: row.project_id,
      mailSlug: row.mail_slug,
      messageCount: Number(row.message_count),
    })),
    topSenders: addresses("sender").map((row) => ({
      address: row.address,
      messageCount: Number(row.message_count),
    })),
    topRecipients: addresses("recipient").map((row) => ({
      address: row.address,
      messageCount: Number(row.message_count),
    })),
    captureLatency: {
      messageCount: latencies.length,
      averageMs:
        latencies.length === 0
          ? 0
          : Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
      p50Ms: nearestRank(latencies, 0.5),
      p95Ms: nearestRank(latencies, 0.95),
      maxMs: latencies.at(-1) ?? 0,
    },
  });
};

export const makeEmailStore = Effect.fn("makeEmailStore")(function* (
  databasePath: string,
): Effect.fn.Return<EmailStoreShape, EmailCaptureError, Scope.Scope> {
  const rootDir = join(dirname(databasePath), "mail");
  const database = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        mkdirSync(dirname(databasePath), { recursive: true });
        mkdirSync(join(rootDir, "raw"), { recursive: true });
        mkdirSync(join(rootDir, "attachments"), { recursive: true });
        const opened = await openRuntimeDatabase(databasePath);
        initializeDatabase(opened);
        return opened;
      },
      catch: (cause) => storageError("Could not open mail.sqlite", cause),
    }),
    (opened) => Effect.sync(() => opened.close()).pipe(Effect.ignore),
  );

  const insert: EmailStoreShape["insert"] = Effect.fn("EmailStore.insert")(
    function* (message, files) {
      yield* Effect.try({
        try: () => {
          database.exec("BEGIN IMMEDIATE");
          try {
            database
              .prepare(
                `INSERT INTO email_messages (id, project_id, mail_slug, matched_by, matched_value, received_at, stored_at, total_duration_ms, is_read, raw_relative_path, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                message.id,
                message.attribution.projectId,
                message.attribution.mailSlug,
                message.attribution.matchedBy,
                message.attribution.matchedValue,
                message.timings.messageReceivedAt,
                message.timings.storedAt,
                message.timings.totalDurationMs,
                message.isRead ? 1 : 0,
                files.rawRelativePath,
                JSON.stringify(message),
              );
            const attachmentStatement = database.prepare(
              `INSERT INTO email_attachments (id, message_id, filename, content_type, content_disposition, content_id, size_bytes, relative_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            );
            for (const file of files.attachments)
              attachmentStatement.run(
                file.attachment.id,
                message.id,
                file.attachment.filename,
                file.attachment.contentType,
                file.attachment.contentDisposition,
                file.attachment.contentId,
                file.attachment.sizeBytes,
                file.relativePath,
              );
            const addressStatement = database.prepare(
              `INSERT OR IGNORE INTO email_message_addresses (message_id, kind, address) VALUES (?, ?, ?)`,
            );
            for (const address of senderAddresses(message))
              addressStatement.run(message.id, "sender", address);
            for (const address of recipientAddresses(message))
              addressStatement.run(message.id, "recipient", address);
            database.exec("COMMIT");
          } catch (cause) {
            database.exec("ROLLBACK");
            throw cause;
          }
        },
        catch: (cause) => storageError("Could not store captured email", cause),
      });
    },
  );

  const writeFiles: EmailStoreShape["writeFiles"] = Effect.fn("EmailStore.writeFiles")(
    function* (messageId, raw, attachments) {
      return yield* Effect.try({
        try: () => {
          const rawRelativePath = join("raw", `${messageId}.eml`);
          writeFileSync(join(rootDir, rawRelativePath), raw);
          const messageAttachmentDir = join("attachments", messageId);
          mkdirSync(join(rootDir, messageAttachmentDir), { recursive: true });
          return {
            rawRelativePath,
            attachments: attachments.map(({ attachment, content }) => {
              const relativePath = join(messageAttachmentDir, attachment.id);
              writeFileSync(join(rootDir, relativePath), content);
              return { attachment, relativePath };
            }),
          };
        },
        catch: (cause) => storageError("Could not write captured email files", cause),
      });
    },
  );

  const capture: EmailStoreShape["capture"] = Effect.fn("EmailStore.capture")(function* (input) {
    const message = { ...input, deliverability: analyzeEmailDeliverability(input) };
    const files = yield* writeFiles(message.id, new Uint8Array(), []);
    yield* insert(message, files);
    return message;
  });

  const getMessage: EmailStoreShape["getMessage"] = Effect.fn("EmailStore.getMessage")(
    function* (messageId) {
      return yield* Effect.try({
        try: () => {
          const row = database
            .prepare(
              "SELECT id, project_id, mail_slug, stored_at, is_read, raw_relative_path, payload_json FROM email_messages WHERE id = ?",
            )
            .get(messageId) as unknown as MessagePayloadRow | undefined;
          return row === undefined ? null : decodeMessage(row);
        },
        catch: (cause) => storageError("Could not read captured email", cause),
      });
    },
  );

  const list: EmailStoreShape["list"] = Effect.fn("EmailStore.list")(function* (input) {
    return yield* Effect.try({
      try: () => {
        const rows = database
          .prepare(
            "SELECT id, project_id, mail_slug, stored_at, is_read, raw_relative_path, payload_json FROM email_messages ORDER BY received_at DESC, id DESC",
          )
          .all() as unknown as ReadonlyArray<MessagePayloadRow>;
        const filtered = rows
          .filter((row) => matchesScope(row, input.scope))
          .filter(
            (row) => input.cursor === undefined || `${row.stored_at}|${row.id}` < input.cursor,
          )
          .map(decodeMessage)
          .filter((message) => matchesFilters(message, input.filters));
        const page = filtered.slice(0, input.limit);
        const last = page.at(-1);
        return {
          messages: page.map(summaryOf),
          nextCursor:
            filtered.length > page.length && last !== undefined
              ? `${last.timings.storedAt}|${last.id}`
              : null,
        };
      },
      catch: (cause) => storageError("Could not list captured emails", cause),
    });
  });

  const deleteIds = (
    ids: ReadonlyArray<EmailMessageId>,
  ): Effect.Effect<ReadonlyArray<EmailMessageId>, EmailCaptureError> =>
    Effect.try({
      try: () => {
        if (ids.length === 0) return ids;
        const rawStatement = database.prepare(
          "SELECT raw_relative_path FROM email_messages WHERE id = ?",
        );
        const attachmentStatement = database.prepare(
          "SELECT relative_path FROM email_attachments WHERE message_id = ?",
        );
        const paths: string[] = [];
        for (const id of ids) {
          const raw = rawStatement.get(id) as unknown as { raw_relative_path: string } | undefined;
          if (raw) paths.push(raw.raw_relative_path);
          paths.push(
            ...(attachmentStatement.all(id) as unknown as ReadonlyArray<AttachmentPathRow>).map(
              (row) => row.relative_path,
            ),
          );
        }
        database.exec("BEGIN IMMEDIATE");
        try {
          const statement = database.prepare("DELETE FROM email_messages WHERE id = ?");
          for (const id of ids) statement.run(id);
          database.exec("COMMIT");
        } catch (cause) {
          database.exec("ROLLBACK");
          throw cause;
        }
        for (const relativePath of paths) rmSync(join(rootDir, relativePath), { force: true });
        for (const id of ids)
          rmSync(join(rootDir, "attachments", id), { recursive: true, force: true });
        return ids;
      },
      catch: (cause) => storageError("Could not delete captured emails", cause),
    });

  const idsForScope = (scope: EmailInboxScope): ReadonlyArray<EmailMessageId> =>
    (
      database
        .prepare(
          "SELECT id, project_id, mail_slug, stored_at, is_read, raw_relative_path, payload_json FROM email_messages",
        )
        .all() as unknown as ReadonlyArray<MessagePayloadRow>
    )
      .filter((row) => matchesScope(row, scope))
      .map((row) => row.id as EmailMessageId);

  const setRead: EmailStoreShape["setRead"] = Effect.fn("EmailStore.setRead")(
    function* (target, isRead) {
      return yield* Effect.try({
        try: () => {
          const ids = target.type === "message" ? [target.messageId] : idsForScope(target);
          const update = database.prepare(
            "UPDATE email_messages SET is_read = ? WHERE id = ? AND is_read != ?",
          );
          const changed: EmailMessageId[] = [];
          for (const id of ids)
            if (Number(update.run(isRead ? 1 : 0, id, isRead ? 1 : 0).changes) > 0)
              changed.push(id);
          return changed;
        },
        catch: (cause) => storageError("Could not update email read state", cause),
      });
    },
  );

  const clear: EmailStoreShape["clear"] = Effect.fn("EmailStore.clear")(function* (scope) {
    return yield* deleteIds(idsForScope(scope));
  });

  const applyRetention: EmailStoreShape["applyRetention"] = Effect.fn("EmailStore.applyRetention")(
    function* ({ policy, projects, nowMs }) {
      const rows = database
        .prepare(
          "SELECT id, project_id, mail_slug, stored_at, is_read, raw_relative_path, payload_json FROM email_messages ORDER BY received_at DESC, id DESC",
        )
        .all() as unknown as ReadonlyArray<MessagePayloadRow>;
      const groups = new Map<string, MessagePayloadRow[]>();
      for (const row of rows) {
        const key = row.project_id ?? "__unassigned__";
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      const evicted = new Set<EmailMessageId>();
      for (const [key, group] of groups) {
        const project = projects.find(({ projectId }) => projectId === key);
        const maxMessages = project?.retention.maxMessages ?? policy.maxMessages;
        const maxAgeDays = project?.retention.maxAgeDays ?? policy.maxAgeDays;
        const cutoff = nowMs - maxAgeDays * 24 * 60 * 60 * 1_000;
        group.forEach((row, index) => {
          if (index >= maxMessages || Date.parse(row.stored_at) < cutoff)
            evicted.add(row.id as EmailMessageId);
        });
      }
      return yield* deleteIds([...evicted]);
    },
  );

  const allMessages = Effect.try({
    try: () =>
      (
        database
          .prepare(
            "SELECT id, project_id, mail_slug, stored_at, is_read, raw_relative_path, payload_json FROM email_messages ORDER BY received_at DESC, id DESC",
          )
          .all() as unknown as ReadonlyArray<MessagePayloadRow>
      ).map(decodeMessage),
    catch: (cause) => storageError("Could not read captured emails", cause),
  });

  const analytics: EmailStoreShape["analytics"] = Effect.fn("EmailStore.analytics")(
    function* (input) {
      const from = input.from === undefined ? null : Date.parse(input.from);
      const to = input.to === undefined ? null : Date.parse(input.to);
      if (
        (from !== null && !Number.isFinite(from)) ||
        (to !== null && !Number.isFinite(to)) ||
        (from !== null && to !== null && from >= to)
      ) {
        return yield* invalidAnalyticsInput("Analytics date range is invalid.");
      }
      return yield* Effect.try({
        try: () => queryAnalytics(database, input),
        catch: (cause) => storageError("Could not query email analytics", cause),
      });
    },
  );

  return EmailStore.of({
    capture,
    writeFiles,
    insert,
    getMessage,
    list,
    setRead,
    clear,
    applyRetention,
    allMessages,
    analytics,
  });
});

export const layerAtPath = (databasePath: string) =>
  Layer.effect(EmailStore, makeEmailStore(databasePath));

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return layerAtPath(join(config.stateDir, "mail.sqlite"));
  }),
);
