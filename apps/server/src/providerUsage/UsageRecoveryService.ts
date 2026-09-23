import {
  CommandId,
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  UsageRecovery,
  UsageRecoveryError,
  type UsageRecoveryResult,
  type UsageRecoveryScheduleInput,
} from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import {
  canResumeUsageRecovery,
  childFailedAt,
  isUsageLimitText,
  RECOVERY_MAX_ATTEMPTS,
  recoveryLatestRun,
  recoveryMarker,
  recoveryPrompt,
  recoveryRetryAt,
  reportedResetAt,
  resumedChildTask,
  runIsWorking,
  usageFailureForRun,
  type RecoveryChild,
} from "./usageRecoveryPolicy.ts";

const StoredRecovery = Schema.Struct({
  ...UsageRecovery.fields,
  expectedRunId: RunId,
  authorizedAt: Schema.String,
  attemptMessageId: Schema.NullOr(MessageId),
  children: Schema.Array(Schema.Struct({ ownerThreadId: ThreadId, taskId: NodeId })),
  /** First attempt time, used to distinguish a stale failure from a restarted child. */
  startedAt: Schema.NullOr(Schema.String),
});
type StoredRecovery = typeof StoredRecovery.Type;
const encode = Schema.encodeEffect(Schema.fromJsonString(StoredRecovery));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRecovery));
const recoveryError = (message: string) => new UsageRecoveryError({ message });
const active = (job: StoredRecovery) => job.status === "scheduled" || job.status === "monitoring";

export class UsageRecoveryService extends Context.Service<
  UsageRecoveryService,
  {
    get(threadId: ThreadId): Effect.Effect<UsageRecoveryResult, UsageRecoveryError>;
    subscribe(threadId: ThreadId): Stream.Stream<UsageRecoveryResult, UsageRecoveryError>;
    schedule(
      input: UsageRecoveryScheduleInput,
    ): Effect.Effect<UsageRecoveryResult, UsageRecoveryError>;
    cancel(threadId: ThreadId): Effect.Effect<UsageRecoveryResult, UsageRecoveryError>;
    reconcile(): Effect.Effect<void, UsageRecoveryError>;
  }
>()("@spiritdevs/pathway/providerUsage/UsageRecoveryService") {}

export const layer = Layer.effect(
  UsageRecoveryService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threads = yield* ThreadManagementService;
    const changes = yield* PubSub.sliding<void>(1);
    const lock = yield* Semaphore.make(1);
    const watched = new Map<ThreadId, Set<ThreadId>>();
    const dirty = new Set<ThreadId>();
    let bootstrapped = false;
    const protect = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.mapError((cause) =>
          recoveryError(cause instanceof Error ? cause.message : String(cause)),
        ),
      );
    const read = (threadId: ThreadId) =>
      protect(
        Effect.gen(function* () {
          const rows = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM usage_recovery WHERE thread_id = ${threadId}`;
          return rows[0] ? yield* decode(rows[0].payload_json) : null;
        }),
      );
    const save = (job: StoredRecovery) =>
      protect(
        Effect.gen(function* () {
          yield* sql`INSERT INTO usage_recovery (thread_id, status, payload_json)
      VALUES (${job.threadId}, ${job.status}, ${yield* encode(job)})
      ON CONFLICT(thread_id) DO UPDATE SET status = excluded.status, payload_json = excluded.payload_json`;
          if (active(job)) {
            watched.set(
              job.threadId,
              new Set([
                ...(watched.get(job.threadId) ?? []),
                job.threadId,
                ...job.children.map((child) => child.ownerThreadId),
              ]),
            );
          } else {
            watched.delete(job.threadId);
            dirty.delete(job.threadId);
          }
          yield* PubSub.publish(changes, undefined);
          return job;
        }),
      );
    const get = (threadId: ThreadId) =>
      protect(
        Effect.gen(function* () {
          let recovery = yield* read(threadId);
          const projection = yield* threads.getThreadProjection(threadId);
          if (recovery && (recovery.status === "failed" || recovery.status === "completed")) {
            const authorizedAt = Date.parse(recovery.authorizedAt);
            if (
              projection.messages.some(
                (message) =>
                  message.createdBy === "user" &&
                  DateTime.toEpochMillis(message.createdAt) > authorizedAt,
              )
            )
              recovery = null;
          }
          let ancestor = projection.thread.lineage.parentThreadId;
          const visited = new Set<ThreadId>();
          while (ancestor !== null && !visited.has(ancestor)) {
            visited.add(ancestor);
            const parentJob = yield* read(ancestor);
            if (parentJob && active(parentJob)) return { recovery: parentJob, eligibility: null };
            ancestor = (yield* threads.getThreadProjection(ancestor)).thread.lineage.parentThreadId;
          }
          const run = recoveryLatestRun(projection);
          const provider = projection.providerThreads.find(
            (thread) => thread.id === run?.providerThreadId,
          );
          if (
            !run ||
            !canResumeUsageRecovery(projection, run.id) ||
            (provider?.driver !== "codex" && provider?.driver !== "claudeAgent")
          )
            return { recovery, eligibility: null };
          const failure = usageFailureForRun(projection, run.id);
          const children = (yield* family(threadId)).filter(
            ({ task }) => task.status !== "completed" && task.status !== "cancelled",
          );
          const blocked = children.filter(({ task }) => isUsageLimitText(task.result ?? ""));
          if (failure === undefined && blocked.length === 0 && recovery?.status !== "scheduled")
            return { recovery, eligibility: null };
          const messages = [
            ...(failure?.type === "error"
              ? [{ text: failure.failure.message, at: DateTime.toEpochMillis(failure.updatedAt) }]
              : []),
            ...blocked.map(({ task }) => ({
              text: task.result!,
              at: childFailedAt(task),
            })),
          ];
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          const resetAt = reportedResetAt(messages);
          return {
            recovery,
            eligibility: {
              sourceRunId: run.id,
              suggestedResumeAt: resetAt === null ? null : recoveryRetryAt(messages, now),
              resetAt: resetAt === null ? null : DateTime.formatIso(DateTime.makeUnsafe(resetAt)),
              childCount: children.length,
            },
          };
        }),
      );

    /** Only traverse this thread's descendants; never scan all conversations for a timer tick. */
    const family = Effect.fn("UsageRecovery.family")(function* (root: ThreadId) {
      const pending = [root];
      const visited = new Set<ThreadId>();
      const result: RecoveryChild[] = [];
      while (pending.length) {
        const threadId = pending.shift()!;
        if (visited.has(threadId)) continue;
        visited.add(threadId);
        const projection = yield* threads.getThreadProjection(threadId);
        if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) {
          const parentIndex = result.findIndex(({ task }) => task.childThreadId === threadId);
          if (parentIndex !== -1) result.splice(parentIndex, 1);
          continue;
        }
        const parentIndex = result.findIndex(({ task }) => task.childThreadId === threadId);
        if (parentIndex !== -1) {
          const entry = result[parentIndex]!;
          const providerThread = projection.providerThreads.find(
            (candidate) =>
              candidate.id === entry.task.providerThreadId ||
              candidate.id === projection.thread.activeProviderThreadId,
          );
          result[parentIndex] = {
            ...entry,
            task: resumedChildTask(entry.task, projection),
            nativeThreadId: providerThread?.nativeThreadRef?.nativeId ?? null,
          };
        }
        for (const task of projection.subagents) {
          result.push({ ownerThreadId: threadId, task });
          if (task.childThreadId !== null) pending.push(task.childThreadId);
        }
      }
      return result;
    });

    const reconcileJob = Effect.fn("UsageRecovery.reconcileJob")(function* (job: StoredRecovery) {
      const projection = yield* threads.getThreadProjection(job.threadId);
      const latest = recoveryLatestRun(projection);
      if (
        !latest ||
        projection.thread.deletedAt !== null ||
        projection.thread.archivedAt !== null ||
        projection.thread.snoozedUntil != null
      ) {
        yield* save({
          ...job,
          status: "cancelled",
          message: "Recovery cancelled because the thread was removed, archived, or snoozed.",
        });
        return;
      }
      // A receipt and message ID survive a server restart between dispatch and recording the run.
      const attemptRun =
        job.attemptMessageId === null
          ? undefined
          : projection.runs.find((run) => run.userMessageId === job.attemptMessageId);
      let expected = attemptRun?.id ?? job.expectedRunId;
      const newerMessage = projection.messages.find(
        (message) => message.id === latest.userMessageId,
      );
      const userIntervened = projection.messages.some(
        (message) =>
          message.role === "user" &&
          message.createdBy === "user" &&
          DateTime.toEpochMillis(message.createdAt) > Date.parse(job.authorizedAt),
      );
      // Native background-result continuations are part of the same recovery.
      // An actual new user request supersedes it, including one sent on another device.
      if (
        !userIntervened &&
        latest.id !== expected &&
        newerMessage?.createdBy === "agent" &&
        (newerMessage.creationSource === "server" || newerMessage.creationSource === "provider")
      ) {
        expected = latest.id;
        if (job.status === "scheduled")
          job = yield* save({
            ...job,
            expectedRunId: latest.id,
            attemptMessageId: null,
            status: "monitoring",
          });
      }
      if (
        userIntervened ||
        latest.id !== expected ||
        ["interrupted", "cancelled", "rolled_back"].includes(latest.status)
      ) {
        yield* save({
          ...job,
          status: "cancelled",
          message: "Recovery cancelled because newer work or a manual stop superseded it.",
        });
        return;
      }
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      const descendants = yield* family(job.threadId);
      watched.set(
        job.threadId,
        new Set([
          job.threadId,
          ...descendants.flatMap(({ ownerThreadId, task }) =>
            task.childThreadId === null ? [ownerThreadId] : [ownerThreadId, task.childThreadId],
          ),
        ]),
      );
      const superseded = new Set<string>();
      const selected = job.children.flatMap((child) => {
        let current = descendants.find(
          ({ ownerThreadId, task }) =>
            ownerThreadId === child.ownerThreadId && task.id === child.taskId,
        );
        const visited = new Set<string>();
        let taskId = child.taskId;
        while (!visited.has(taskId)) {
          visited.add(taskId);
          const replacement = descendants.findLast(
            ({ task }) =>
              task.id !== taskId && task.prompt.includes(recoveryMarker(job.id, taskId)),
          );
          if (!replacement) break;
          superseded.add(taskId);
          current = replacement;
          taskId = replacement.task.id;
        }
        return current ? [current] : [];
      });
      // Newly delegated descendants also belong to this recovery, including replacements' children.
      const children = [
        ...selected,
        ...descendants.filter(
          ({ task }) =>
            job.startedAt !== null &&
            task.startedAt !== null &&
            DateTime.toEpochMillis(task.startedAt) >= Date.parse(job.startedAt) &&
            !superseded.has(task.id) &&
            !selected.some((child) => child.task.id === task.id),
        ),
      ];
      if (job.status === "scheduled" && attemptRun === undefined) {
        if (Date.parse(job.resumeAt) > nowMs || !canResumeUsageRecovery(projection, expected))
          return;
        const attempt = job.attempts + 1;
        const messageId = MessageId.make(`usage-recovery:${job.id}:${attempt}`);
        const sending = {
          ...job,
          attemptMessageId: messageId,
          startedAt: job.startedAt ?? DateTime.formatIso(now),
        };
        yield* save(sending);
        const dispatched = yield* threads
          .dispatch({
            type: "message.dispatch",
            threadId: job.threadId,
            commandId: CommandId.make(messageId),
            messageId,
            usageRecoveryOfRunId: expected,
            dispatchMode: { type: "start_immediately" },
            text: recoveryPrompt({ recoveryId: job.id, attempt, children }),
            attachments: [],
            createdBy: "system",
            creationSource: "server",
          })
          .pipe(Effect.result);
        if (dispatched._tag === "Failure") {
          const current = yield* threads.getThreadProjection(job.threadId);
          const committed = current.messages.some((message) => message.id === messageId);
          if (!committed) {
            const superseded = !canResumeUsageRecovery(current, expected);
            yield* save({
              ...sending,
              attempts: attempt,
              status: superseded ? "cancelled" : "failed",
              message: superseded
                ? "Recovery was superseded by newer work or a user action."
                : `Could not start recovery: ${dispatched.failure.message}`,
            });
            return;
          }
        }
        yield* save({
          ...sending,
          status: "monitoring",
          attempts: attempt,
          message: `Recovery attempt ${attempt} of 3 started. The parent is resuming its unfinished children.`,
        });
        return;
      }
      // Repair the persisted phase if the process stopped just after the durable dispatch.
      if (job.status === "scheduled" && attemptRun) {
        job = yield* save({ ...job, status: "monitoring", attempts: job.attempts + 1 });
      }
      if (runIsWorking(latest)) return;
      const failure = usageFailureForRun(projection, latest.id);
      if (latest.status === "failed" && failure === undefined) {
        yield* save({
          ...job,
          status: "failed",
          message: "Recovery stopped on a different error. Review the thread before continuing.",
        });
        return;
      }
      const blocked = children.filter(
        ({ task }) => task.status === "failed" || task.status === "interrupted",
      );
      const working = children.some(({ task }) =>
        ["pending", "running", "waiting"].includes(task.status),
      );
      if (failure?.type === "error" || (blocked.length && !working)) {
        if (
          job.attempts >= RECOVERY_MAX_ATTEMPTS ||
          (latest.status === "failed" && failure === undefined)
        ) {
          yield* save({
            ...job,
            status: "failed",
            message:
              "Automatic recovery stopped. Review the thread and child results before continuing manually.",
          });
          return;
        }
        const errors = [
          ...(failure?.type === "error"
            ? [{ text: failure.failure.message, at: DateTime.toEpochMillis(failure.updatedAt) }]
            : []),
          ...blocked
            .filter(({ task }) => isUsageLimitText(task.result ?? ""))
            .map(({ task }) => ({
              text: task.result!,
              at: childFailedAt(task),
            })),
        ];
        yield* save({
          ...job,
          status: "scheduled",
          expectedRunId: latest.id,
          attemptMessageId: null,
          resumeAt: recoveryRetryAt(errors, nowMs),
          children: [
            ...job.children,
            ...children
              .filter(
                ({ task }) => !selected.some((selectedChild) => selectedChild.task.id === task.id),
              )
              .map(({ ownerThreadId, task }) => ({ ownerThreadId, taskId: task.id })),
          ],
          message: `${blocked.length ? `${blocked.length} child task(s) still need recovery. ` : ""}Waiting to retry; ${job.attempts} of 3 attempts used.`,
        });
        return;
      }
      if (working) return;
      yield* save({
        ...job,
        status: "completed",
        message:
          "The recovery turn and its children finished. Results are available in the conversation.",
      });
    });

    const reconcileActive = (background: boolean) =>
      lock.withPermit(
        protect(
          Effect.gen(function* () {
            const rows = yield* sql<{
              payload_json: string;
            }>`SELECT payload_json FROM usage_recovery WHERE status IN ('scheduled', 'monitoring')`;
            const now = DateTime.toEpochMillis(yield* DateTime.now);
            for (const row of rows) {
              const job = yield* decode(row.payload_json);
              if (!watched.has(job.threadId))
                watched.set(
                  job.threadId,
                  new Set([
                    ...(watched.get(job.threadId) ?? []),
                    job.threadId,
                    ...job.children.map((child) => child.ownerThreadId),
                  ]),
                );
              if (
                background &&
                bootstrapped &&
                !dirty.has(job.threadId) &&
                (job.status === "monitoring" || Date.parse(job.resumeAt) > now)
              )
                continue;
              dirty.delete(job.threadId);
              yield* reconcileJob(job).pipe(
                Effect.catch((cause) =>
                  Effect.gen(function* () {
                    dirty.add(job.threadId);
                    yield* Effect.logWarning("Usage recovery deferred", {
                      threadId: job.threadId,
                      cause,
                    });
                  }),
                ),
              );
            }
            bootstrapped = true;
          }),
        ),
      );
    const reconcile = () => reconcileActive(false);

    const schedule = (input: UsageRecoveryScheduleInput) =>
      lock.withPermit(
        protect(
          Effect.gen(function* () {
            const previous = yield* read(input.threadId);
            if (previous?.id === input.commandId) return { recovery: previous };
            const projection = yield* threads.getThreadProjection(input.threadId);
            let ancestor = projection.thread.lineage.parentThreadId;
            const ancestors = new Set<ThreadId>();
            while (ancestor !== null && !ancestors.has(ancestor)) {
              ancestors.add(ancestor);
              const parentJob = yield* read(ancestor);
              if (parentJob && active(parentJob))
                return yield* recoveryError(
                  "This child is included in its parent's recovery. Manage the timer from the parent thread.",
                );
              ancestor = (yield* threads.getThreadProjection(ancestor)).thread.lineage
                .parentThreadId;
            }
            const run = recoveryLatestRun(projection);
            if (
              !run ||
              run.id !== input.sourceRunId ||
              !canResumeUsageRecovery(projection, run.id)
            ) {
              return yield* recoveryError(
                "The thread has changed. Stop or finish its current work before scheduling recovery.",
              );
            }
            const provider = projection.providerThreads.find(
              (thread) => thread.id === run.providerThreadId,
            );
            if (provider?.driver !== "codex" && provider?.driver !== "claudeAgent") {
              return yield* recoveryError("Usage recovery currently supports Claude and Codex.");
            }
            const descendants = yield* family(input.threadId);
            const children = descendants.filter(
              ({ task }) => task.status !== "completed" && task.status !== "cancelled",
            );
            if (
              previous?.status !== "scheduled" &&
              !usageFailureForRun(projection, run.id) &&
              !children.some(({ task }) => isUsageLimitText(task.result ?? ""))
            ) {
              return yield* recoveryError(
                "No usage-limit failure was found in this thread or its children.",
              );
            }
            const now = yield* DateTime.now;
            // A time that has already passed means "resume now"; the next reconcile tick starts it.
            const resumeAt =
              Date.parse(input.resumeAt) <= DateTime.toEpochMillis(now)
                ? DateTime.formatIso(now)
                : input.resumeAt;
            if (previous?.status === "monitoring")
              return yield* recoveryError(
                "Recovery is already running. Cancel it before scheduling another timer.",
              );
            for (const { task } of descendants) {
              if (task.childThreadId === null) continue;
              const childJob = yield* read(task.childThreadId);
              if (childJob && active(childJob))
                yield* save({
                  ...childJob,
                  status: "cancelled",
                  message: "Recovery is now managed by the parent thread's timer.",
                });
            }
            const recovery = yield* save({
              id: input.commandId,
              threadId: input.threadId,
              sourceRunId: input.sourceRunId,
              expectedRunId: run.id,
              attemptMessageId: null,
              startedAt: null,
              authorizedAt: DateTime.formatIso(now),
              status: "scheduled",
              resumeAt,
              attempts: previous?.status === "scheduled" ? previous.attempts : 0,
              children: children.map(({ ownerThreadId, task }) => ({
                ownerThreadId,
                taskId: task.id,
              })),
              message: `Scheduled to continue this thread and ${children.length} unfinished child task(s).`,
            });
            return { recovery };
          }),
        ),
      );
    const cancel = (threadId: ThreadId) =>
      lock.withPermit(
        protect(
          Effect.gen(function* () {
            const job = yield* read(threadId);
            return {
              recovery:
                job && active(job)
                  ? yield* save({
                      ...job,
                      status: "cancelled",
                      message:
                        "Recovery timer cancelled. Work already running can be stopped with the thread's Stop control.",
                    })
                  : job,
            };
          }),
        ),
      );
    const subscribe = (threadId: ThreadId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(get(threadId)),
            Stream.merge(
              Stream.fromSubscription(subscription),
              threads.streamDomainEvents.pipe(
                Stream.filter(
                  (event) =>
                    event.threadId === threadId &&
                    ((event.type === "run.updated" && !runIsWorking(event.payload)) ||
                      (event.type === "subagent.updated" &&
                        ["completed", "failed", "interrupted", "cancelled"].includes(
                          event.payload.status,
                        ))),
                ),
                Stream.map(() => undefined),
                Stream.mapError((cause) => recoveryError(String(cause))),
              ),
            ).pipe(Stream.mapEffect(() => get(threadId))),
          );
        }),
      );
    yield* forkParked(
      threads.streamDomainEvents.pipe(
        Stream.filter((event) =>
          [
            "run.created",
            "run.updated",
            "subagent.created",
            "subagent.updated",
            "thread.archived",
            "thread.deleted",
            "thread.snoozed",
            "thread.settled",
          ].includes(event.type),
        ),
        Stream.runForEach((event) =>
          Effect.sync(() => {
            for (const [root, members] of watched) if (members.has(event.threadId)) dirty.add(root);
          }),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Usage recovery event subscription failed", { cause }).pipe(
            Effect.andThen(
              Effect.sync(() => {
                bootstrapped = false;
              }),
            ),
          ),
        ),
        Effect.repeat(Schedule.spaced("5 seconds")),
      ),
    );
    yield* forkParked(
      reconcileActive(true).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Usage recovery reconciliation failed", { cause }),
        ),
        Effect.repeat(Schedule.spaced("5 seconds")),
      ),
    );
    return UsageRecoveryService.of({ get, subscribe, schedule, cancel, reconcile });
  }),
);
