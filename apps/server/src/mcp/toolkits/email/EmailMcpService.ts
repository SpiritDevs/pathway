import {
  type CapturedEmailMessage,
  EmailCaptureError,
  type EmailInboxScope,
  type EmailMcpCreateTaskResult,
  type EmailMcpGetInput,
  type EmailMcpLatestCodeResult,
  type EmailMcpListInput,
  type EmailMcpLongPollResult,
  type EmailMcpProject,
  type EmailMcpTaskState,
  type EmailMcpWaitForInput,
  type EmailProjectSettings,
  type EmailWaitRegistration,
  type ProjectId,
} from "@spiritdevs/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { EmailStore } from "../../../email/EmailStore.ts";
import { EmailWaitStore } from "../../../email/EmailWaitStore.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";

export const DEFAULT_EMAIL_WAIT_TIMEOUT_MS = 120_000;
export const MAX_EMAIL_WAIT_TIMEOUT_MS = 10 * 60_000;
export const EMAIL_TASK_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_EMAIL_MCP_LIST_LIMIT = 50;
export const MAX_EMAIL_MCP_LIST_LIMIT = 200;

export const emailMcpListLimit = (limit: number | undefined): number =>
  Math.min(Math.max(1, limit ?? DEFAULT_EMAIL_MCP_LIST_LIMIT), MAX_EMAIL_MCP_LIST_LIMIT);

/**
 * The list is ordered newest-first by `(receivedAt, id)`, so the cursor is that composite key —
 * a bare message id is random and would skip and repeat rows across pages.
 */
export const emailMcpListCursor = (message: CapturedEmailMessage): string =>
  `${message.timings.messageReceivedAt}|${message.id}`;

const failure = (reason: "not-found" | "invalid" | "storage", message: string) =>
  new EmailCaptureError({ reason, message });

export class EmailMcpProjectScope extends Context.Service<
  EmailMcpProjectScope,
  {
    readonly resolve: (
      invocation: McpInvocationScope,
      project: EmailMcpProject | undefined,
    ) => Effect.Effect<EmailInboxScope, EmailCaptureError>;
  }
>()("@spiritdevs/pathway/mcp/toolkits/email/EmailMcpService/EmailMcpProjectScope") {}

export const EmailMcpProjectScopeLive = Layer.effect(
  EmailMcpProjectScope,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService;
    const settings = yield* ServerSettingsService;
    return EmailMcpProjectScope.of({
      resolve: Effect.fn("EmailMcpProjectScope.resolve")(function* (invocation, project) {
        if (project === "all") return { type: "all" };
        if (project !== undefined) {
          const current = yield* settings.getSettings.pipe(
            Effect.mapError(() => failure("storage", "Could not read email project settings.")),
          );
          const matched = current.emailCapture.projects.find(
            ({ mailSlug }) => mailSlug === project,
          );
          if (matched === undefined) {
            return yield* failure("not-found", `No email project has mail slug '${project}'.`);
          }
          return { type: "project", projectId: matched.projectId };
        }
        const projection = yield* threads
          .getThreadProjection(invocation.threadId)
          .pipe(
            Effect.mapError(() =>
              failure(
                "not-found",
                `The calling thread '${invocation.threadId}' does not have a project.`,
              ),
            ),
          );
        return { type: "project", projectId: projection.thread.projectId };
      }),
    });
  }),
);

export const EmailMcpProjectScopeTest = (input: {
  readonly projectByThread: ReadonlyMap<string, ProjectId>;
  readonly projects: ReadonlyArray<EmailProjectSettings>;
}) =>
  Layer.succeed(
    EmailMcpProjectScope,
    EmailMcpProjectScope.of({
      resolve: (invocation, project) => {
        if (project === "all") return Effect.succeed({ type: "all" });
        if (project !== undefined) {
          const matched = input.projects.find(({ mailSlug }) => mailSlug === project);
          return matched === undefined
            ? Effect.fail(failure("not-found", `No email project has mail slug '${project}'.`))
            : Effect.succeed({ type: "project", projectId: matched.projectId });
        }
        const projectId = input.projectByThread.get(invocation.threadId);
        return projectId === undefined
          ? Effect.fail(failure("not-found", "The calling thread does not have a project."))
          : Effect.succeed({ type: "project", projectId });
      },
    }),
  );

const messageMatchesScope = (message: CapturedEmailMessage, scope: EmailInboxScope): boolean =>
  scope.type === "all" ||
  (scope.type === "unassigned" && message.attribution.projectId === null) ||
  (scope.type === "project" && message.attribution.projectId === scope.projectId);

const contains = (values: ReadonlyArray<string>, needle: string | undefined): boolean =>
  needle === undefined ||
  values.some((value) => value.toLowerCase().includes(needle.toLowerCase()));

const messageMatchesList = (
  message: CapturedEmailMessage,
  scope: EmailInboxScope,
  input: EmailMcpListInput,
): boolean =>
  messageMatchesScope(message, scope) &&
  contains(
    message.parsedHeaders.from.map(({ address }) => address),
    input.sender,
  ) &&
  contains([message.parsedHeaders.subject ?? ""], input.subject) &&
  contains(
    [
      ...message.envelope.rcptTo,
      ...message.parsedHeaders.to.map(({ address }) => address),
      ...message.parsedHeaders.cc.map(({ address }) => address),
      ...message.parsedHeaders.bcc.map(({ address }) => address),
    ],
    input.recipient,
  ) &&
  (input.isRead === undefined || message.isRead === input.isRead);

const taskState = (
  registration: EmailWaitRegistration,
  message: CapturedEmailMessage | null,
): EmailMcpTaskState => {
  const createdAt = registration.registeredAt;
  const lastUpdatedAt = registration.completedAt ?? registration.registeredAt;
  return {
    taskId: registration.taskId ?? registration.id,
    status:
      registration.status === "pending"
        ? "working"
        : registration.status === "completed"
          ? "completed"
          : registration.status === "cancelled"
            ? "cancelled"
            : "failed",
    createdAt,
    lastUpdatedAt,
    ttlMs: Math.max(
      1,
      DateTime.toEpochMillis(DateTime.makeUnsafe(registration.expiresAt)) -
        DateTime.toEpochMillis(DateTime.makeUnsafe(registration.registeredAt)),
    ),
    pollIntervalMs: EMAIL_TASK_POLL_INTERVAL_MS,
    result: message,
    error: registration.status === "expired" ? "The email wait expired." : null,
  };
};

export class EmailMcpService extends Context.Service<
  EmailMcpService,
  {
    readonly waitFor: (
      invocation: McpInvocationScope,
      input: EmailMcpWaitForInput,
      tasksSupported: boolean,
    ) => Effect.Effect<EmailMcpCreateTaskResult | EmailMcpLongPollResult, EmailCaptureError>;
    readonly latestCode: (
      invocation: McpInvocationScope,
      project: EmailMcpProject | undefined,
    ) => Effect.Effect<Option.Option<EmailMcpLatestCodeResult>, EmailCaptureError>;
    readonly list: (
      invocation: McpInvocationScope,
      input: EmailMcpListInput,
    ) => Effect.Effect<ReadonlyArray<CapturedEmailMessage>, EmailCaptureError>;
    readonly get: (
      invocation: McpInvocationScope,
      input: EmailMcpGetInput,
    ) => Effect.Effect<CapturedEmailMessage, EmailCaptureError>;
    readonly getTask: (
      invocation: McpInvocationScope,
      taskId: string,
    ) => Effect.Effect<EmailMcpTaskState, EmailCaptureError>;
    readonly updateTask: (
      invocation: McpInvocationScope,
      taskId: string,
    ) => Effect.Effect<EmailMcpTaskState, EmailCaptureError>;
    readonly cancelTask: (
      invocation: McpInvocationScope,
      taskId: string,
    ) => Effect.Effect<EmailMcpTaskState, EmailCaptureError>;
    readonly taskNotifications: Stream.Stream<EmailMcpTaskState, EmailCaptureError>;
    readonly subscribeTaskNotifications: (
      invocation: McpInvocationScope,
    ) => Effect.Effect<Stream.Stream<EmailMcpTaskState, EmailCaptureError>, never, Scope.Scope>;
  }
>()("@spiritdevs/pathway/mcp/toolkits/email/EmailMcpService") {}

const make = Effect.fn("EmailMcpService.make")(function* () {
  const store = yield* EmailStore;
  const waits = yield* EmailWaitStore;
  const scopes = yield* EmailMcpProjectScope;
  const crypto = yield* Crypto.Crypto;

  const findMessage = Effect.fn("EmailMcpService.findMessage")(function* (messageId: string) {
    const message = yield* store.getMessage(messageId as CapturedEmailMessage["id"]);
    return message === null ? Option.none<CapturedEmailMessage>() : Option.some(message);
  });

  const registrationForTask = Effect.fn("EmailMcpService.registrationForTask")(function* (
    invocation: McpInvocationScope,
    taskId: string,
  ) {
    const registration = yield* waits.getByTaskId(taskId);
    if (
      Option.isNone(registration) ||
      registration.value.threadId !== invocation.threadId ||
      registration.value.providerInstanceId !== invocation.providerInstanceId
    ) {
      return yield* failure("not-found", `Email task '${taskId}' was not found.`);
    }
    return registration.value;
  });

  const stateForRegistration = Effect.fn("EmailMcpService.stateForRegistration")(function* (
    registration: EmailWaitRegistration,
  ) {
    const message =
      registration.matchedMessageId === null
        ? Option.none<CapturedEmailMessage>()
        : yield* findMessage(registration.matchedMessageId);
    return taskState(registration, Option.getOrNull(message));
  });

  const getTask: EmailMcpService["Service"]["getTask"] = Effect.fn("EmailMcpService.getTask")(
    function* (invocation, taskId) {
      return yield* stateForRegistration(yield* registrationForTask(invocation, taskId));
    },
  );

  const updateTask: EmailMcpService["Service"]["updateTask"] = Effect.fn(
    "EmailMcpService.updateTask",
  )(function* (invocation, taskId) {
    const state = yield* getTask(invocation, taskId);
    if (state.status !== "working") return state;
    return yield* failure("invalid", `Email task '${taskId}' is not awaiting client input.`);
  });

  const cancelTask: EmailMcpService["Service"]["cancelTask"] = Effect.fn(
    "EmailMcpService.cancelTask",
  )(function* (invocation, taskId) {
    yield* registrationForTask(invocation, taskId);
    const registration = yield* waits.cancelTask(taskId);
    if (Option.isNone(registration)) {
      return yield* failure("not-found", `Email task '${taskId}' was not found.`);
    }
    return yield* stateForRegistration(registration.value);
  });

  const list: EmailMcpService["Service"]["list"] = Effect.fn("EmailMcpService.list")(
    function* (invocation, input) {
      const scope = yield* scopes.resolve(invocation, input.project);
      const messages = yield* store.allMessages;
      return messages
        .filter(
          (message) =>
            messageMatchesList(message, scope, input) &&
            (input.cursor === undefined || emailMcpListCursor(message) < input.cursor),
        )
        .slice(0, emailMcpListLimit(input.limit));
    },
  );

  const get: EmailMcpService["Service"]["get"] = Effect.fn("EmailMcpService.get")(
    function* (invocation, input) {
      const scope = yield* scopes.resolve(invocation, input.project);
      const message = yield* findMessage(input.messageId);
      if (Option.isNone(message) || !messageMatchesScope(message.value, scope)) {
        return yield* failure("not-found", `Captured email '${input.messageId}' was not found.`);
      }
      return message.value;
    },
  );

  const latestCode: EmailMcpService["Service"]["latestCode"] = Effect.fn(
    "EmailMcpService.latestCode",
  )(function* (invocation, project) {
    const scope = yield* scopes.resolve(invocation, project);
    const messages = yield* store.allMessages;
    const message = messages.find(
      (candidate) => candidate.detectedCode !== null && messageMatchesScope(candidate, scope),
    );
    if (message === undefined || message.detectedCode === null) return Option.none();
    const now = yield* Clock.currentTimeMillis;
    return Option.some({
      messageId: message.id,
      code: message.detectedCode,
      sender: message.parsedHeaders.from[0]?.address ?? null,
      receivedAt: message.timings.messageReceivedAt,
      ageMs: Math.max(
        0,
        now - DateTime.toEpochMillis(DateTime.makeUnsafe(message.timings.messageReceivedAt)),
      ),
    });
  });

  const waitFor: EmailMcpService["Service"]["waitFor"] = Effect.fn("EmailMcpService.waitFor")(
    function* (invocation, input, tasksSupported) {
      const scope = yield* scopes.resolve(invocation, input.project);
      const timeoutMs = Math.min(
        Math.max(1, input.timeoutMs ?? DEFAULT_EMAIL_WAIT_TIMEOUT_MS),
        MAX_EMAIL_WAIT_TIMEOUT_MS,
      );
      const delivery = tasksSupported ? "task" : "long-poll";
      const taskId = tasksSupported ? yield* crypto.randomUUIDv4.pipe(Effect.orDie) : null;
      const registration = yield* waits.register({
        threadId: invocation.threadId,
        providerInstanceId: invocation.providerInstanceId,
        criteria: {
          scope,
          sender: input.sender ?? null,
          subject: input.subject ?? null,
          recipient: input.recipient ?? null,
        },
        delivery,
        timeoutMs,
        taskId,
      });
      if (tasksSupported) {
        return { task: taskState(registration, null) };
      }

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const completionEvents = yield* waits.subscribeCompletions;
          const current = yield* waits.get(registration.id);
          if (Option.isSome(current) && current.value.matchedMessageId !== null) {
            const message = yield* findMessage(current.value.matchedMessageId);
            return { message: Option.getOrNull(message), timedOut: false };
          }
          const completion = yield* completionEvents.pipe(
            Stream.filter(({ registrations }) =>
              registrations.some(({ id }) => id === registration.id),
            ),
            Stream.map(({ message }) => message),
            Stream.runHead,
            Effect.timeoutOption(timeoutMs),
            Effect.map(Option.flatten),
          );
          return Option.match(completion, {
            onNone: () => ({ message: null, timedOut: true }),
            onSome: (message) => ({ message, timedOut: false }),
          });
        }),
      );
    },
  );

  const taskNotifications = waits.taskUpdates.pipe(
    Stream.filter(({ registration }) => registration.taskId !== null),
    Stream.map(({ message, registration }) => taskState(registration, message)),
  );
  const subscribeTaskNotifications: EmailMcpService["Service"]["subscribeTaskNotifications"] = (
    invocation,
  ) =>
    waits.subscribeTaskUpdates.pipe(
      Effect.map((stream) =>
        stream.pipe(
          Stream.filter(
            ({ registration }) =>
              registration.taskId !== null &&
              registration.threadId === invocation.threadId &&
              registration.providerInstanceId === invocation.providerInstanceId,
          ),
          Stream.map(({ message, registration }) => taskState(registration, message)),
        ),
      ),
    );

  return EmailMcpService.of({
    waitFor,
    latestCode,
    list,
    get,
    getTask,
    updateTask,
    cancelTask,
    taskNotifications,
    subscribeTaskNotifications,
  });
});

export const layer = Layer.effect(EmailMcpService, make());
