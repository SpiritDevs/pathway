import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EmailCaptureError,
  type CapturedEmailMessage,
  type EmailStreamEvent,
  EmailTriggerFiring,
  EmailTriggerFiringId,
  type EmailTriggerFiringsListInput,
  type EmailTriggerFiringsListResult,
  type EmailTriggerMatcher,
  EmailTriggerRule,
  type EmailTriggerRuleDeleteInput,
  type EmailTriggerRuleDeleteResult,
  EmailTriggerRuleId,
  type EmailTriggerRuleMutationResult,
  type EmailTriggerRulesListInput,
  type EmailTriggerRulesListResult,
  type EmailTriggerRuleUpsertInput,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EmailCapture from "./EmailCaptureService.ts";

const HOUR_MS = 60 * 60 * 1_000;
const DEFAULT_FIRING_LOG_LIMIT = 50;
const MAX_FIRING_LOG_LIMIT = 200;

interface RuleRow {
  readonly rule_id: string;
  readonly project_id: string;
  readonly name: string;
  readonly enabled: number;
  readonly sender: string | null;
  readonly subject: string | null;
  readonly recipient: string | null;
  readonly prompt_template: string;
  readonly max_triggers_per_hour: number;
  readonly rate_limit_window_started_at: string | null;
  readonly triggers_in_current_window: number;
  readonly auto_disabled_at: string | null;
  readonly auto_disabled_reason: string | null;
}

interface FiringRow {
  readonly firing_id: string;
  readonly rule_id: string;
  readonly project_id: string;
  readonly message_id: string;
  readonly thread_id: string;
  readonly fired_at: string;
  readonly fired_ms: number;
  readonly status: string;
  readonly error: string | null;
  readonly loop_message_id: string | null;
}

export type EmailTriggerProcessingResult =
  | { readonly type: "launched"; readonly firing: EmailTriggerFiring }
  | { readonly type: "failed"; readonly firing: EmailTriggerFiring }
  | {
      readonly type: "rate-limited";
      readonly ruleId: EmailTriggerRuleId;
      readonly messageId: CapturedEmailMessage["id"];
    }
  | {
      readonly type: "loop-disabled";
      readonly rule: EmailTriggerRule;
      readonly firing: EmailTriggerFiring;
      readonly loopMessageId: CapturedEmailMessage["id"];
    };

export interface ProcessCapturedEmailInput {
  readonly message: CapturedEmailMessage;
  /** Trusted run provenance supplied by the capture bridge, never parsed from sender headers. */
  readonly originatingThreadId?: ThreadId;
}

export class EmailTriggerService extends Context.Service<
  EmailTriggerService,
  {
    readonly listRules: (
      input: EmailTriggerRulesListInput,
    ) => Effect.Effect<EmailTriggerRulesListResult, EmailCaptureError>;
    readonly upsertRule: (
      input: EmailTriggerRuleUpsertInput,
    ) => Effect.Effect<EmailTriggerRuleMutationResult, EmailCaptureError>;
    readonly deleteRule: (
      input: EmailTriggerRuleDeleteInput,
    ) => Effect.Effect<EmailTriggerRuleDeleteResult, EmailCaptureError>;
    readonly listFirings: (
      input: EmailTriggerFiringsListInput,
    ) => Effect.Effect<EmailTriggerFiringsListResult, EmailCaptureError>;
    readonly processMessage: (
      input: ProcessCapturedEmailInput,
    ) => Effect.Effect<ReadonlyArray<EmailTriggerProcessingResult>, EmailCaptureError>;
    readonly notices: Stream.Stream<EmailStreamEvent>;
  }
>()("t3/email/EmailTriggerService") {}

const triggerError = (reason: EmailCaptureError["reason"], message: string) =>
  new EmailCaptureError({ reason, message });

const storageError = (message: string, _cause?: unknown) => triggerError("storage", message);

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);

const iso = (millis: number): string => DateTime.formatIso(DateTime.makeUnsafe(millis));

const includes = (values: ReadonlyArray<string>, needle: string | null): boolean =>
  needle === null || values.some((value) => value.toLowerCase().includes(needle.toLowerCase()));

export function emailMatchesTrigger(
  message: CapturedEmailMessage,
  matcher: EmailTriggerMatcher,
): boolean {
  return (
    includes(
      [
        ...message.parsedHeaders.from.map(({ address }) => address),
        ...(message.envelope.mailFrom === null ? [] : [message.envelope.mailFrom]),
      ],
      matcher.sender,
    ) &&
    includes([message.parsedHeaders.subject ?? ""], matcher.subject) &&
    includes(
      [
        ...message.envelope.rcptTo,
        ...message.parsedHeaders.to.map(({ address }) => address),
        ...message.parsedHeaders.cc.map(({ address }) => address),
        ...message.parsedHeaders.bcc.map(({ address }) => address),
      ],
      matcher.recipient,
    )
  );
}

export function renderEmailTriggerPrompt(template: string, message: CapturedEmailMessage): string {
  const variables = {
    sender:
      message.parsedHeaders.from.map(({ address }) => address).join(", ") ||
      message.envelope.mailFrom ||
      "",
    subject: message.parsedHeaders.subject ?? "",
    body: message.textBody ?? message.htmlBody ?? "",
    // `code` is the name the rule editor advertises; `detectedCode` is kept as an alias so
    // templates written against either spelling interpolate.
    code: message.detectedCode ?? "",
    detectedCode: message.detectedCode ?? "",
    messageId: message.id,
  } as const;
  return template.replace(
    /{{\s*(sender|subject|body|code|detectedCode|messageId)\s*}}/g,
    (_match, name: keyof typeof variables) => variables[name],
  );
}

const decodeRuleRow = (row: RuleRow) =>
  Schema.decodeUnknownEffect(EmailTriggerRule)({
    id: row.rule_id,
    name: row.name,
    enabled: row.enabled === 1,
    matcher: { sender: row.sender, subject: row.subject, recipient: row.recipient },
    promptTemplate: row.prompt_template,
    maxTriggersPerHour: row.max_triggers_per_hour,
    rateLimitWindowStartedAt: row.rate_limit_window_started_at,
    triggersInCurrentWindow: row.triggers_in_current_window,
    autoDisabledAt: row.auto_disabled_at,
    autoDisabledReason: row.auto_disabled_reason,
  }).pipe(
    Effect.mapError((cause) =>
      storageError(`Stored email trigger '${row.rule_id}' is invalid.`, cause),
    ),
  );

const decodeFiringRow = (row: FiringRow) =>
  Schema.decodeUnknownEffect(EmailTriggerFiring)({
    id: row.firing_id,
    ruleId: row.rule_id,
    projectId: row.project_id,
    messageId: row.message_id,
    threadId: row.thread_id,
    firedAt: row.fired_at,
    status: row.status,
    error: row.error,
    loopMessageId: row.loop_message_id,
  }).pipe(
    Effect.mapError((cause) =>
      storageError(`Stored email trigger firing '${row.firing_id}' is invalid.`, cause),
    ),
  );

const RULE_COLUMNS = `
  rule_id, project_id, name, enabled, sender, subject, recipient, prompt_template,
  max_triggers_per_hour, rate_limit_window_started_at, triggers_in_current_window,
  auto_disabled_at, auto_disabled_reason
`;

const FIRING_COLUMNS = `
  firing_id, rule_id, project_id, message_id, thread_id, fired_at, fired_ms,
  status, error, loop_message_id
`;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const notices = yield* PubSub.sliding<EmailStreamEvent>(64);
  const allRuleColumns = sql.literal(RULE_COLUMNS);
  const allFiringColumns = sql.literal(FIRING_COLUMNS);

  const selectRule = Effect.fn("EmailTriggerService.selectRule")(function* (
    ruleId: EmailTriggerRuleId,
    projectId?: string,
  ) {
    const rows = yield* (
      projectId === undefined
        ? sql<RuleRow>`SELECT ${allRuleColumns} FROM email_trigger_rules WHERE rule_id = ${ruleId}`
        : sql<RuleRow>`
          SELECT ${allRuleColumns}
          FROM email_trigger_rules
          WHERE rule_id = ${ruleId} AND project_id = ${projectId}
        `
    ).pipe(Effect.mapError((cause) => storageError("Could not read email trigger rule.", cause)));
    const row = rows[0];
    return row === undefined
      ? Option.none<EmailTriggerRule>()
      : Option.some(yield* decodeRuleRow(row));
  });

  const listRules: EmailTriggerService["Service"]["listRules"] = Effect.fn(
    "EmailTriggerService.listRules",
  )(function* (input) {
    const rows = yield* sql<RuleRow>`
      SELECT ${allRuleColumns}
      FROM email_trigger_rules
      WHERE project_id = ${input.projectId}
      ORDER BY name COLLATE NOCASE ASC, rule_id ASC
    `.pipe(Effect.mapError((cause) => storageError("Could not list email trigger rules.", cause)));
    return { rules: yield* Effect.forEach(rows, decodeRuleRow, { concurrency: 1 }) };
  });

  const upsertRule: EmailTriggerService["Service"]["upsertRule"] = Effect.fn(
    "EmailTriggerService.upsertRule",
  )(function* (input) {
    if (
      input.matcher.sender === null &&
      input.matcher.subject === null &&
      input.matcher.recipient === null
    ) {
      return yield* triggerError("invalid", "An email trigger rule needs at least one matcher.");
    }
    const id =
      input.id ??
      EmailTriggerRuleId.make(
        `email-trigger-rule:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
      );
    const existing = yield* selectRule(id);
    if (Option.isSome(existing) && input.id !== undefined) {
      const ownerRows = yield* sql<{ readonly project_id: string }>`
        SELECT project_id FROM email_trigger_rules WHERE rule_id = ${id}
      `.pipe(
        Effect.mapError((cause) => storageError("Could not read email trigger owner.", cause)),
      );
      if (ownerRows[0]?.project_id !== input.projectId) {
        return yield* triggerError("conflict", "Email trigger rule belongs to another project.");
      }
    }
    const prior = Option.getOrNull(existing);
    const clearsAutoDisable = input.enabled && prior !== null && prior.autoDisabledAt !== null;
    const rule = yield* Schema.decodeUnknownEffect(EmailTriggerRule)({
      id,
      name: input.name,
      enabled: input.enabled,
      matcher: input.matcher,
      promptTemplate: input.promptTemplate,
      maxTriggersPerHour: input.maxTriggersPerHour,
      rateLimitWindowStartedAt: prior?.rateLimitWindowStartedAt ?? null,
      triggersInCurrentWindow: prior?.triggersInCurrentWindow ?? 0,
      autoDisabledAt: clearsAutoDisable ? null : (prior?.autoDisabledAt ?? null),
      autoDisabledReason: clearsAutoDisable ? null : (prior?.autoDisabledReason ?? null),
    }).pipe(Effect.mapError(() => triggerError("invalid", "Email trigger rule is invalid.")));
    yield* sql`
      INSERT INTO email_trigger_rules (
        rule_id, project_id, name, enabled, sender, subject, recipient, prompt_template,
        max_triggers_per_hour, rate_limit_window_started_at, triggers_in_current_window,
        auto_disabled_at, auto_disabled_reason
      ) VALUES (
        ${rule.id}, ${input.projectId}, ${rule.name}, ${rule.enabled ? 1 : 0},
        ${rule.matcher.sender}, ${rule.matcher.subject}, ${rule.matcher.recipient},
        ${rule.promptTemplate}, ${rule.maxTriggersPerHour}, ${rule.rateLimitWindowStartedAt},
        ${rule.triggersInCurrentWindow}, ${rule.autoDisabledAt}, ${rule.autoDisabledReason}
      )
      ON CONFLICT(rule_id) DO UPDATE SET
        name = excluded.name,
        enabled = excluded.enabled,
        sender = excluded.sender,
        subject = excluded.subject,
        recipient = excluded.recipient,
        prompt_template = excluded.prompt_template,
        max_triggers_per_hour = excluded.max_triggers_per_hour,
        rate_limit_window_started_at = excluded.rate_limit_window_started_at,
        triggers_in_current_window = excluded.triggers_in_current_window,
        auto_disabled_at = excluded.auto_disabled_at,
        auto_disabled_reason = excluded.auto_disabled_reason
    `.pipe(Effect.mapError((cause) => storageError("Could not save email trigger rule.", cause)));
    return { rule };
  });

  const deleteRule: EmailTriggerService["Service"]["deleteRule"] = Effect.fn(
    "EmailTriggerService.deleteRule",
  )(function* (input) {
    const deleted = yield* sql<{ readonly rule_id: string }>`
      DELETE FROM email_trigger_rules
      WHERE rule_id = ${input.ruleId} AND project_id = ${input.projectId}
      RETURNING rule_id
    `.pipe(Effect.mapError((cause) => storageError("Could not delete email trigger rule.", cause)));
    if (deleted.length === 0)
      return yield* triggerError("not-found", "Email trigger rule not found.");
    return { ruleId: input.ruleId };
  });

  const listFirings: EmailTriggerService["Service"]["listFirings"] = Effect.fn(
    "EmailTriggerService.listFirings",
  )(function* (input) {
    const rows = yield* sql<FiringRow>`
      SELECT ${allFiringColumns}
      FROM email_trigger_firings
      WHERE project_id = ${input.projectId}
        AND (${input.ruleId ?? null} IS NULL OR rule_id = ${input.ruleId ?? null})
        AND (
          ${input.cursor ?? null} IS NULL
          OR fired_ms < (
            SELECT fired_ms FROM email_trigger_firings WHERE firing_id = ${input.cursor ?? null}
          )
          OR (
            fired_ms = (
              SELECT fired_ms FROM email_trigger_firings WHERE firing_id = ${input.cursor ?? null}
            )
            AND firing_id < ${input.cursor ?? null}
          )
        )
      ORDER BY fired_ms DESC, firing_id DESC
      LIMIT ${Math.min(input.limit ?? DEFAULT_FIRING_LOG_LIMIT, MAX_FIRING_LOG_LIMIT) + 1}
    `.pipe(
      Effect.mapError((cause) => storageError("Could not list email trigger firings.", cause)),
    );
    const limit = Math.min(input.limit ?? DEFAULT_FIRING_LOG_LIMIT, MAX_FIRING_LOG_LIMIT);
    const page = rows.slice(0, limit);
    return {
      firings: yield* Effect.forEach(page, decodeFiringRow, { concurrency: 1 }),
      nextCursor: rows.length > limit ? EmailTriggerFiringId.make(page.at(-1)!.firing_id) : null,
    };
  });

  const disableLoop = Effect.fn("EmailTriggerService.disableLoop")(function* (
    rule: EmailTriggerRule,
    message: CapturedEmailMessage,
    originatingThreadId: ThreadId,
    currentMillis: number,
  ) {
    const firingRows = yield* sql<FiringRow>`
      SELECT ${allFiringColumns}
      FROM email_trigger_firings
      WHERE rule_id = ${rule.id} AND thread_id = ${originatingThreadId} AND status = 'launched'
      ORDER BY fired_ms DESC
      LIMIT 1
    `;
    const source = firingRows[0];
    if (source === undefined) return Option.none<EmailTriggerProcessingResult>();
    const disabledAt = iso(currentMillis);
    const reason = `Auto-disabled after thread ${originatingThreadId} produced matching email ${message.id}.`;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          UPDATE email_trigger_rules
          SET enabled = 0, auto_disabled_at = ${disabledAt}, auto_disabled_reason = ${reason}
          WHERE rule_id = ${rule.id}
        `;
        yield* sql`
          UPDATE email_trigger_firings
          SET status = 'loop-detected', loop_message_id = ${message.id}
          WHERE firing_id = ${source.firing_id}
        `;
        yield* sql`
          INSERT INTO email_trigger_processed_messages (rule_id, message_id, processed_ms, outcome)
          VALUES (${rule.id}, ${message.id}, ${currentMillis}, 'loop-detected')
          ON CONFLICT(rule_id, message_id) DO NOTHING
        `;
      }),
    );
    const disabledRule = yield* selectRule(rule.id).pipe(Effect.map(Option.getOrThrow));
    const updatedRows = yield* sql<FiringRow>`
      SELECT ${allFiringColumns} FROM email_trigger_firings WHERE firing_id = ${source.firing_id}
    `;
    const firing = yield* decodeFiringRow(updatedRows[0]!);
    const notice = `Email trigger “${rule.name}” was disabled because its own run produced another matching message.`;
    yield* PubSub.publish(notices, {
      _tag: "EmailTriggerRuleAutoDisabled",
      rule: disabledRule,
      firing,
      loopMessageId: message.id,
      notice,
    });
    return Option.some({
      type: "loop-disabled" as const,
      rule: disabledRule,
      firing,
      loopMessageId: message.id,
    });
  });

  const fireRule = Effect.fn("EmailTriggerService.fireRule")(function* (
    rule: EmailTriggerRule,
    message: CapturedEmailMessage,
    currentMillis: number,
  ) {
    const firingId = EmailTriggerFiringId.make(`email-trigger-firing:${rule.id}:${message.id}`);
    const threadId = ThreadId.make(`email-trigger-thread:${rule.id}:${message.id}`);
    const firedAt = iso(currentMillis);
    const claim = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const processed = yield* sql<{ readonly rule_id: string }>`
          INSERT INTO email_trigger_processed_messages (rule_id, message_id, processed_ms, outcome)
          VALUES (${rule.id}, ${message.id}, ${currentMillis}, 'checking')
          ON CONFLICT(rule_id, message_id) DO NOTHING
          RETURNING rule_id
        `;
          if (processed.length === 0) return "duplicate" as const;
          const current = yield* selectRule(rule.id).pipe(Effect.map(Option.getOrNull));
          if (current === null || !current.enabled) return "disabled" as const;
          const windowStartMs =
            current.rateLimitWindowStartedAt === null
              ? currentMillis
              : Date.parse(current.rateLimitWindowStartedAt);
          const startsNewWindow =
            current.rateLimitWindowStartedAt === null ||
            !Number.isFinite(windowStartMs) ||
            currentMillis - windowStartMs >= HOUR_MS;
          const triggerCount = startsNewWindow ? 0 : current.triggersInCurrentWindow;
          if (triggerCount >= current.maxTriggersPerHour) {
            yield* sql`
            UPDATE email_trigger_processed_messages
            SET outcome = 'rate-limited'
            WHERE rule_id = ${rule.id} AND message_id = ${message.id}
          `;
            return "rate-limited" as const;
          }
          yield* sql`
          INSERT INTO email_trigger_firings (
            firing_id, rule_id, project_id, message_id, thread_id, fired_at, fired_ms,
            status, error, loop_message_id
          ) VALUES (
            ${firingId}, ${rule.id}, ${message.attribution.projectId}, ${message.id}, ${threadId},
            ${firedAt}, ${currentMillis}, 'launched', NULL, NULL
          )
        `;
          yield* sql`
          UPDATE email_trigger_rules
          SET rate_limit_window_started_at = ${startsNewWindow ? firedAt : current.rateLimitWindowStartedAt},
              triggers_in_current_window = ${triggerCount + 1}
          WHERE rule_id = ${rule.id}
        `;
          yield* sql`
          UPDATE email_trigger_processed_messages
          SET outcome = 'fired'
          WHERE rule_id = ${rule.id} AND message_id = ${message.id}
        `;
          return "claimed" as const;
        }),
      )
      .pipe(
        Effect.mapError((cause) => storageError("Could not claim email trigger firing.", cause)),
      );

    if (claim === "duplicate" || claim === "disabled")
      return Option.none<EmailTriggerProcessingResult>();
    if (claim === "rate-limited") {
      return Option.some({ type: "rate-limited" as const, ruleId: rule.id, messageId: message.id });
    }

    const project = yield* projects
      .getById(message.attribution.projectId!)
      .pipe(
        Effect.mapError((cause) => storageError("Could not resolve email trigger project.", cause)),
      );
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError((cause) => storageError("Could not read settings for email trigger.", cause)),
    );
    const modelSelection = Option.match(project, {
      onNone: () => settings.textGenerationModelSelection,
      onSome: (value) => value.defaultModelSelection ?? settings.textGenerationModelSelection,
    });
    const launchExit = yield* Effect.exit(
      threadLaunch.launch({
        commandId: CommandId.make(`email-trigger:${rule.id}:${message.id}`),
        threadId,
        projectId: message.attribution.projectId!,
        title: `Email: ${rule.name}`,
        modelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make(`email-trigger-message:${rule.id}:${message.id}`),
          text: renderEmailTriggerPrompt(rule.promptTemplate, message),
          attachments: [],
        },
        createdBy: "system",
        creationSource: "server",
      }),
    );
    if (launchExit._tag === "Failure") {
      const detail = errorMessage(launchExit.cause);
      yield* sql`
        UPDATE email_trigger_firings SET status = 'failed', error = ${detail}
        WHERE firing_id = ${firingId}
      `.pipe(
        Effect.mapError((cause) => storageError("Could not record failed email trigger.", cause)),
      );
    }
    const rows = yield* sql<FiringRow>`
      SELECT ${allFiringColumns} FROM email_trigger_firings WHERE firing_id = ${firingId}
    `.pipe(Effect.mapError((cause) => storageError("Could not read email trigger firing.", cause)));
    const firing = yield* decodeFiringRow(rows[0]!);
    return Option.some({
      type: launchExit._tag === "Success" ? ("launched" as const) : ("failed" as const),
      firing,
    });
  });

  const processMessage: EmailTriggerService["Service"]["processMessage"] = Effect.fn(
    "EmailTriggerService.processMessage",
  )(function* ({ message, originatingThreadId }) {
    const projectId = message.attribution.projectId;
    if (projectId === null) return [];
    const clockMillis = yield* Clock.currentTimeMillis;
    const storedMillis = Date.parse(message.timings.storedAt);
    // `storedAt` is assigned by the capture service, so it is both trusted and deterministic
    // across retries. Fall back to the Effect clock for legacy/corrupt internal callers.
    const currentMillis = Number.isFinite(storedMillis) ? storedMillis : clockMillis;
    const { rules } = yield* listRules({ projectId });
    const matching = rules.filter(
      (rule) => rule.enabled && emailMatchesTrigger(message, rule.matcher),
    );
    const results: Array<EmailTriggerProcessingResult> = [];
    for (const rule of matching) {
      if (originatingThreadId !== undefined) {
        const loop = yield* disableLoop(rule, message, originatingThreadId, currentMillis).pipe(
          Effect.mapError((cause) => storageError("Could not apply email loop protection.", cause)),
        );
        if (Option.isSome(loop)) {
          results.push(loop.value);
          continue;
        }
      }
      const result = yield* fireRule(rule, message, currentMillis);
      if (Option.isSome(result)) results.push(result.value);
    }
    return results;
  });

  return EmailTriggerService.of({
    listRules,
    upsertRule,
    deleteRule,
    listFirings,
    processMessage,
    notices: Stream.fromPubSub(notices),
  });
});

export const layer = Layer.effect(EmailTriggerService, make);

/** Reacts to the durable capture receipt rather than the SMTP callback, keeping agent work out of
 * the listener transaction and preserving the command/event boundary in ThreadLaunchService. */
export const reactorLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const capture = yield* EmailCapture.EmailCaptureService;
    const triggers = yield* EmailTriggerService;
    yield* capture.stored.pipe(
      Stream.runForEach((receipt) =>
        triggers
          .processMessage({
            message: receipt.message,
            ...(receipt.originatingThreadId === undefined
              ? {}
              : { originatingThreadId: receipt.originatingThreadId }),
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Email trigger processing failed", {
                messageId: receipt.message.id,
                cause,
              }),
            ),
          ),
      ),
      Effect.forkScoped,
    );
  }),
);
