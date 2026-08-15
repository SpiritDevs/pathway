// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  type CapturedEmailMessage,
  EmailCaptureError,
  type EmailWaitCriteria,
  EmailWaitCriteria as EmailWaitCriteriaSchema,
  type EmailWaitDelivery,
  EmailWaitRegistration,
  EmailWaitRegistrationId,
  type ProviderInstanceId,
  type ThreadId,
} from "@spiritdevs/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";

interface WaitRow {
  readonly id: string;
  readonly registration_json: string;
}

const decodeWait = Schema.decodeUnknownSync(Schema.fromJsonString(EmailWaitRegistration));
const encodeWait = Schema.encodeSync(Schema.fromJsonString(EmailWaitRegistration));
const encodeCriteria = Schema.encodeSync(Schema.fromJsonString(EmailWaitCriteriaSchema));

const storageError = (message: string, cause?: unknown) =>
  new EmailCaptureError({
    reason: "storage",
    message: cause instanceof Error ? `${message}: ${cause.message}` : message,
  });

const iso = (millis: number): string => DateTime.formatIso(DateTime.makeUnsafe(millis));

const includes = (values: ReadonlyArray<string>, needle: string | null): boolean =>
  needle === null || values.some((value) => value.toLowerCase().includes(needle.toLowerCase()));

export function emailMatchesWait(
  message: CapturedEmailMessage,
  criteria: EmailWaitCriteria,
): boolean {
  const scopeMatches =
    criteria.scope.type === "all" ||
    (criteria.scope.type === "unassigned" && message.attribution.projectId === null) ||
    (criteria.scope.type === "project" &&
      message.attribution.projectId === criteria.scope.projectId);
  return (
    scopeMatches &&
    includes(
      message.parsedHeaders.from.map(({ address }) => address),
      criteria.sender,
    ) &&
    includes([message.parsedHeaders.subject ?? ""], criteria.subject) &&
    includes(
      [
        ...message.envelope.rcptTo,
        ...message.parsedHeaders.to.map(({ address }) => address),
        ...message.parsedHeaders.cc.map(({ address }) => address),
        ...message.parsedHeaders.bcc.map(({ address }) => address),
      ],
      criteria.recipient,
    )
  );
}

export interface RegisterEmailWaitInput {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly criteria: EmailWaitCriteria;
  readonly delivery: EmailWaitDelivery;
  readonly timeoutMs: number;
  readonly taskId?: string | null;
}

export interface EmailWaitCompletion {
  readonly message: CapturedEmailMessage;
  readonly registrations: ReadonlyArray<EmailWaitRegistration>;
}

export interface EmailWaitTaskUpdate {
  readonly message: CapturedEmailMessage | null;
  readonly registration: EmailWaitRegistration;
}

export class EmailWaitStore extends Context.Service<
  EmailWaitStore,
  {
    readonly register: (
      input: RegisterEmailWaitInput,
    ) => Effect.Effect<EmailWaitRegistration, EmailCaptureError>;
    readonly get: (
      id: EmailWaitRegistrationId,
    ) => Effect.Effect<Option.Option<EmailWaitRegistration>, EmailCaptureError>;
    readonly getByTaskId: (
      taskId: string,
    ) => Effect.Effect<Option.Option<EmailWaitRegistration>, EmailCaptureError>;
    readonly completeMatching: (
      message: CapturedEmailMessage,
    ) => Effect.Effect<ReadonlyArray<EmailWaitRegistration>, EmailCaptureError>;
    readonly cancelTask: (
      taskId: string,
    ) => Effect.Effect<Option.Option<EmailWaitRegistration>, EmailCaptureError>;
    readonly registrations: Stream.Stream<EmailWaitRegistration>;
    readonly subscribeRegistrations: Effect.Effect<
      Stream.Stream<EmailWaitRegistration>,
      never,
      Scope.Scope
    >;
    readonly completions: Stream.Stream<EmailWaitCompletion>;
    readonly subscribeCompletions: Effect.Effect<
      Stream.Stream<EmailWaitCompletion>,
      never,
      Scope.Scope
    >;
    readonly taskUpdates: Stream.Stream<EmailWaitTaskUpdate>;
    readonly subscribeTaskUpdates: Effect.Effect<
      Stream.Stream<EmailWaitTaskUpdate>,
      never,
      Scope.Scope
    >;
  }
>()("@spiritdevs/pathway/email/EmailWaitStore") {}

const initialize = (database: NodeSqlite.DatabaseSync): void => {
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS email_waits (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      criteria_json TEXT NOT NULL,
      delivery TEXT NOT NULL,
      task_id TEXT UNIQUE,
      status TEXT NOT NULL,
      registered_ms INTEGER NOT NULL,
      expires_ms INTEGER NOT NULL,
      completed_ms INTEGER,
      matched_message_id TEXT,
      registration_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS email_waits_pending_idx
      ON email_waits(status, expires_ms, registered_ms);
  `);
};

const make = Effect.fn("EmailWaitStore.make")(function* (databasePath: string) {
  const database = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        if (databasePath !== ":memory:")
          NodeFS.mkdirSync(NodePath.dirname(databasePath), { recursive: true });
        const opened = new NodeSqlite.DatabaseSync(databasePath, { timeout: 5_000 });
        initialize(opened);
        return opened;
      },
      catch: (cause) => storageError("Could not open email wait database", cause),
    }),
    (opened) => Effect.sync(() => opened.close()).pipe(Effect.ignore),
  );
  const crypto = yield* Crypto.Crypto;
  const registrations = yield* PubSub.sliding<EmailWaitRegistration>(256);
  const completions = yield* PubSub.sliding<EmailWaitCompletion>(256);
  const taskUpdates = yield* PubSub.sliding<EmailWaitTaskUpdate>(256);

  const rowBy = (column: "id" | "task_id", value: string): Option.Option<EmailWaitRegistration> => {
    const row = database
      .prepare(`SELECT id, registration_json FROM email_waits WHERE ${column} = ?`)
      .get(value) as WaitRow | undefined;
    return row === undefined ? Option.none() : Option.some(decodeWait(row.registration_json));
  };

  const get: EmailWaitStore["Service"]["get"] = (id) =>
    Effect.try({
      try: () => rowBy("id", id),
      catch: (cause) => storageError("Could not read email wait", cause),
    });
  const getByTaskId: EmailWaitStore["Service"]["getByTaskId"] = (taskId) =>
    Effect.try({
      try: () => rowBy("task_id", taskId),
      catch: (cause) => storageError("Could not read email task", cause),
    });

  const register: EmailWaitStore["Service"]["register"] = Effect.fn("EmailWaitStore.register")(
    function* (input) {
      const registeredMs = yield* Clock.currentTimeMillis;
      const expiresMs = registeredMs + input.timeoutMs;
      const criteriaJson = encodeCriteria(input.criteria);
      const existing = yield* Effect.try({
        try: () =>
          database
            .prepare(`
              SELECT id, registration_json FROM email_waits
              WHERE thread_id = ? AND provider_instance_id = ? AND criteria_json = ?
                AND delivery = ? AND expires_ms >= ? AND status IN ('pending', 'completed')
              ORDER BY registered_ms DESC, id DESC LIMIT 1
            `)
            .get(
              input.threadId,
              input.providerInstanceId,
              criteriaJson,
              input.delivery,
              registeredMs,
            ) as WaitRow | undefined,
        catch: (cause) => storageError("Could not resume email wait", cause),
      });
      if (existing !== undefined) {
        const resumed = decodeWait(existing.registration_json);
        yield* PubSub.publish(registrations, resumed);
        return resumed;
      }
      const registration = EmailWaitRegistration.make({
        id: EmailWaitRegistrationId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
        threadId: input.threadId,
        providerInstanceId: input.providerInstanceId,
        criteria: input.criteria,
        delivery: input.delivery,
        taskId: input.taskId ?? null,
        status: "pending",
        registeredAt: iso(registeredMs),
        expiresAt: iso(expiresMs),
        completedAt: null,
        matchedMessageId: null,
      });
      yield* Effect.try({
        try: () =>
          database
            .prepare(`
              INSERT INTO email_waits (
                id, thread_id, provider_instance_id, criteria_json, delivery, task_id, status,
                registered_ms, expires_ms, completed_ms, matched_message_id, registration_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
            `)
            .run(
              registration.id,
              registration.threadId,
              registration.providerInstanceId,
              criteriaJson,
              registration.delivery,
              registration.taskId,
              registration.status,
              registeredMs,
              expiresMs,
              encodeWait(registration),
            ),
        catch: (cause) => storageError("Could not persist email wait", cause),
      });
      yield* PubSub.publish(registrations, registration);
      return registration;
    },
  );

  const completeMatching: EmailWaitStore["Service"]["completeMatching"] = Effect.fn(
    "EmailWaitStore.completeMatching",
  )(function* (message) {
    const completedMs = yield* Clock.currentTimeMillis;
    const completed = yield* Effect.try({
      try: () => {
        const rows = database
          .prepare(`
            SELECT id, registration_json FROM email_waits
            WHERE status = 'pending' AND expires_ms >= ? ORDER BY registered_ms, id
          `)
          .all(completedMs) as unknown as ReadonlyArray<WaitRow>;
        const matching = rows
          .map((row) => decodeWait(row.registration_json))
          .filter((registration) => emailMatchesWait(message, registration.criteria));
        database.exec("BEGIN IMMEDIATE");
        try {
          const update = database.prepare(`
            UPDATE email_waits SET status = 'completed', completed_ms = ?,
              matched_message_id = ?, registration_json = ?
            WHERE id = ? AND status = 'pending'
          `);
          for (const registration of matching) {
            const next = EmailWaitRegistration.make({
              ...registration,
              status: "completed",
              completedAt: iso(completedMs),
              matchedMessageId: message.id,
            });
            update.run(completedMs, message.id, encodeWait(next), registration.id);
          }
          database.exec("COMMIT");
        } catch (cause) {
          database.exec("ROLLBACK");
          throw cause;
        }
        return matching.map((registration) =>
          EmailWaitRegistration.make({
            ...registration,
            status: "completed",
            completedAt: iso(completedMs),
            matchedMessageId: message.id,
          }),
        );
      },
      catch: (cause) => storageError("Could not complete email waits", cause),
    });
    if (completed.length > 0) {
      yield* PubSub.publish(completions, { message, registrations: completed });
      yield* Effect.forEach(
        completed.filter(({ taskId }) => taskId !== null),
        (registration) => PubSub.publish(taskUpdates, { message, registration }),
        { discard: true },
      );
    }
    return completed;
  });

  const cancelTask: EmailWaitStore["Service"]["cancelTask"] = Effect.fn(
    "EmailWaitStore.cancelTask",
  )(function* (taskId) {
    const cancelledMs = yield* Clock.currentTimeMillis;
    const cancelled = yield* Effect.try({
      try: () => {
        const current = rowBy("task_id", taskId);
        if (Option.isNone(current) || current.value.status !== "pending") {
          return { registration: current, changed: false } as const;
        }
        const next = EmailWaitRegistration.make({
          ...current.value,
          status: "cancelled",
          completedAt: iso(cancelledMs),
        });
        database
          .prepare(`
            UPDATE email_waits SET status = 'cancelled', completed_ms = ?, registration_json = ?
            WHERE task_id = ? AND status = 'pending'
          `)
          .run(cancelledMs, encodeWait(next), taskId);
        return { registration: Option.some(next), changed: true } as const;
      },
      catch: (cause) => storageError("Could not cancel email task", cause),
    });
    if (cancelled.changed && Option.isSome(cancelled.registration)) {
      yield* PubSub.publish(taskUpdates, {
        message: null,
        registration: cancelled.registration.value,
      });
    }
    return cancelled.registration;
  });

  return EmailWaitStore.of({
    register,
    get,
    getByTaskId,
    completeMatching,
    cancelTask,
    registrations: Stream.fromPubSub(registrations),
    subscribeRegistrations: PubSub.subscribe(registrations).pipe(
      Effect.map(Stream.fromSubscription),
    ),
    completions: Stream.fromPubSub(completions),
    subscribeCompletions: PubSub.subscribe(completions).pipe(Effect.map(Stream.fromSubscription)),
    taskUpdates: Stream.fromPubSub(taskUpdates),
    subscribeTaskUpdates: PubSub.subscribe(taskUpdates).pipe(Effect.map(Stream.fromSubscription)),
  });
});

export const layerAtPath = (databasePath: string) =>
  Layer.effect(EmailWaitStore, make(databasePath));

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return layerAtPath(`${config.stateDir}/mail.sqlite`);
  }),
);
