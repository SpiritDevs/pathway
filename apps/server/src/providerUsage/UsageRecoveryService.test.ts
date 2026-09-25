import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Command,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { emptyProjection } from "../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import { ServerActivation } from "../serverActivation.ts";
import { layer, UsageRecoveryService } from "./UsageRecoveryService.ts";
import {
  canResumeUsageRecovery,
  recoveryLatestRun,
  recoveryMarker,
  recoveryRetryAt,
} from "./usageRecoveryPolicy.ts";

const rootId = ThreadId.make("recovery-root");
const instanceId = ProviderInstanceId.make("claude");
const providerThreadId = ProviderThreadId.make("provider-thread");
const now = DateTime.makeUnsafe(0);
const quotaMessage = "You've hit your session limit · resets in 1 minute";

function projection(threadId = rootId): OrchestrationV2ThreadProjection {
  return emptyProjection({
    type: "thread.created",
    id: EventId.make(`event:${threadId}`),
    threadId,
    occurredAt: now,
    payload: {
      id: threadId,
      projectId: null,
      title: "Recovery test",
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "claude-opus-4-6" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: {
        rootThreadId: rootId,
        parentThreadId: threadId === rootId ? null : rootId,
        relationshipToParent: threadId === rootId ? null : "subagent",
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      createdBy: "user",
      creationSource: "web",
    },
  });
}

function run(
  id: string,
  ordinal = 1,
  status: OrchestrationV2Run["status"] = "failed",
): OrchestrationV2Run {
  return {
    id: RunId.make(id),
    threadId: rootId,
    ordinal,
    status,
    providerInstanceId: instanceId,
    providerThreadId,
    modelSelection: { instanceId, model: "claude-opus-4-6" },
    userMessageId: MessageId.make(`message:${id}`),
    rootNodeId: null,
    activeAttemptId: null,
    requestedAt: now,
    startedAt: now,
    completedAt: now,
    checkpointId: null,
    contextHandoffId: null,
  };
}

function child(
  id: string,
  status: OrchestrationV2Subagent["status"] = "failed",
): OrchestrationV2Subagent {
  return {
    id: NodeId.make(id),
    threadId: rootId,
    runId: RunId.make("initial"),
    parentNodeId: NodeId.make("parent"),
    origin: "provider_native",
    createdBy: "agent",
    driver: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: instanceId,
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: {
      driver: ProviderDriverKind.make("claudeAgent"),
      nativeId: `native:${id}`,
      strength: "strong",
    },
    title: id,
    prompt: `Finish ${id}`,
    model: "claude-opus-4-6",
    status,
    result: status === "failed" ? quotaMessage : null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
}

function withFailure(
  p: OrchestrationV2ThreadProjection,
  selected: OrchestrationV2Run,
  at = now,
  message = quotaMessage,
): OrchestrationV2ThreadProjection {
  return {
    ...p,
    runs: [
      ...p.runs.filter((item) => item.id !== selected.id),
      { ...selected, status: "failed", completedAt: at },
    ],
    turnItems: [
      ...p.turnItems,
      {
        id: TurnItemId.make(`error:${selected.id}`),
        type: "error",
        threadId: p.thread.id,
        runId: selected.id,
        nodeId: null,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: p.turnItems.length + 1,
        status: "failed",
        title: null,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
        failure: { class: "provider_error", code: "rate_limit", message, retryable: false },
      },
    ],
  };
}

function fixture(dispatchFailure?: "before" | "after" | "compact") {
  const initial = withFailure(projection(), run("initial"));
  const projections = new Map<ThreadId, OrchestrationV2ThreadProjection>([
    [
      rootId,
      {
        ...initial,
        providerThreads: [
          {
            id: providerThreadId,
            driver: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: instanceId,
            providerSessionId: ProviderSessionId.make("session"),
            appThreadId: rootId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver: ProviderDriverKind.make("claudeAgent"),
              nativeId: "native",
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    ],
  ]);
  const commands: Extract<OrchestrationV2Command, { type: "message.dispatch" }>[] = [];
  const interrupts: RunId[] = [];
  const deps = Layer.mergeAll(
    SqlitePersistenceMemory,
    Layer.succeed(ServerActivation, Effect.never),
    Layer.mock(ThreadManagementService)({
      getThreadProjection: (id) => Effect.sync(() => projections.get(id)!),
      streamDomainEvents: Stream.never,
      dispatch: (command) =>
        Effect.gen(function* () {
          if (command.type === "run.interrupt") {
            const p = projections.get(command.threadId)!;
            interrupts.push(command.runId);
            projections.set(command.threadId, {
              ...p,
              runs: p.runs.map((item) =>
                item.id === command.runId ? { ...item, status: "interrupted" } : item,
              ),
            });
            return { sequence: 0, storedEvents: [] };
          }
          assert.equal(command.type, "message.dispatch");
          if (command.type !== "message.dispatch") return { sequence: 0, storedEvents: [] };
          const p = projections.get(command.threadId)!;
          if (p.messages.some((message) => message.id === command.messageId))
            return { sequence: 0, storedEvents: [] };
          assert.isTrue(canResumeUsageRecovery(p, command.usageRecoveryOfRunId!));
          if (
            dispatchFailure === "before" ||
            (dispatchFailure === "compact" && command.text === "/compact")
          )
            return yield* new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
            });
          commands.push(command);
          const at = yield* DateTime.now;
          const nextRun = {
            ...run(`attempt-${commands.length}`, p.runs.length + 1, "running"),
            userMessageId: command.messageId,
            requestedAt: at,
            startedAt: at,
          };
          projections.set(command.threadId, {
            ...p,
            runs: [...p.runs, nextRun],
            messages: [
              ...p.messages,
              {
                id: command.messageId,
                threadId: command.threadId,
                runId: nextRun.id,
                nodeId: null,
                role: "user",
                text: command.text,
                attachments: [],
                streaming: false,
                createdAt: at,
                updatedAt: at,
                createdBy: "system",
                creationSource: "server",
              },
            ],
          });
          if (dispatchFailure === "after")
            return yield* new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
            });
          return { sequence: 1, storedEvents: [] };
        }),
    }),
  );
  return {
    projections,
    commands,
    interrupts,
    deps,
    serviceLayer: layer.pipe(Layer.provide(deps)),
    schedule: {
      commandId: CommandId.make("recovery-job"),
      threadId: rootId,
      sourceRunId: RunId.make("initial"),
      resumeAt: "1970-01-01T00:02:00.000Z",
    },
  };
}

it.effect("persists one timer, includes nested children, and preserves completed tasks", () => {
  const f = fixture();
  const nestedId = ThreadId.make("nested-parent");
  f.projections.set(rootId, {
    ...f.projections.get(rootId)!,
    subagents: [{ ...child("builder"), childThreadId: nestedId }, child("finished", "completed")],
  });
  f.projections.set(nestedId, { ...projection(nestedId), subagents: [child("nested-builder")] });
  return Effect.gen(function* () {
    const service = yield* UsageRecoveryService;
    yield* service.schedule(f.schedule);
    yield* service.schedule(f.schedule);
    assert.equal((yield* service.get(nestedId)).recovery?.threadId, rootId);
    yield* service.reconcile();
    assert.lengthOf(f.commands, 0);
    yield* TestClock.adjust("2 minutes");
    yield* service.reconcile();
    yield* service.reconcile();
    assert.lengthOf(f.commands, 1);
    assert.include(f.commands[0]!.text, "native:builder");
    assert.include(f.commands[0]!.text, "native:nested-builder");
    assert.notInclude(f.commands[0]!.text, '"title": "finished"');
    assert.include(f.commands[0]!.text, "originalTask");
    assert.equal((yield* service.get(rootId)).recovery?.attempts, 1);
  }).pipe(Effect.provide(f.serviceLayer));
});

it.effect("resumes immediately once the reported reset has passed", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* UsageRecoveryService;
    yield* TestClock.adjust("2 minutes");
    const eligibility = (yield* service.get(rootId)).eligibility!;
    assert.equal(eligibility.resetAt, "1970-01-01T00:01:00.000Z");
    const { recovery } = yield* service.schedule({ ...f.schedule, resumeAt: eligibility.resetAt! });
    assert.equal(recovery?.resumeAt, "1970-01-01T00:02:00.000Z");
    yield* service.reconcile();
    assert.lengthOf(f.commands, 1);
  }).pipe(Effect.provide(f.serviceLayer));
});

it.effect("uses the newly reported reset and stops after three attempts", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* UsageRecoveryService;
    yield* service.schedule(f.schedule);
    for (let attempt = 1; attempt <= 3; attempt++) {
      yield* TestClock.adjust("2 minutes");
      yield* service.reconcile();
      assert.lengthOf(f.commands, attempt);
      const p = f.projections.get(rootId)!;
      f.projections.set(rootId, withFailure(p, recoveryLatestRun(p)!, yield* DateTime.now));
      yield* service.reconcile();
      const saved = (yield* service.get(rootId)).recovery!;
      assert.equal(saved.attempts, attempt);
      assert.equal(saved.status, attempt === 3 ? "failed" : "scheduled");
      if (attempt < 3)
        assert.equal(
          Date.parse(saved.resumeAt),
          DateTime.toEpochMillis(yield* DateTime.now) + 120_000,
        );
    }
    yield* TestClock.adjust("1 hour");
    yield* service.reconcile();
    assert.lengthOf(f.commands, 3);
  }).pipe(Effect.provide(f.serviceLayer));
});

it.effect(
  "retries a child failure after the main turn finishes and tells the parent what failed",
  () => {
    const f = fixture();
    f.projections.set(rootId, { ...f.projections.get(rootId)!, subagents: [child("builder")] });
    return Effect.gen(function* () {
      const service = yield* UsageRecoveryService;
      yield* service.schedule(f.schedule);
      yield* TestClock.adjust("2 minutes");
      yield* service.reconcile();
      const p = f.projections.get(rootId)!;
      const at = yield* DateTime.now;
      f.projections.set(rootId, {
        ...p,
        runs: p.runs.map((item) => ({ ...item, status: "completed" })),
        subagents: [{ ...child("builder"), updatedAt: at }],
      });
      yield* service.reconcile();
      assert.equal((yield* service.get(rootId)).recovery?.status, "scheduled");
      yield* TestClock.adjust("2 minutes");
      yield* service.reconcile();
      assert.lengthOf(f.commands, 2);
      assert.include(f.commands[1]!.text, '"status": "failed"');
      assert.include(f.commands[1]!.text, quotaMessage);
    }).pipe(Effect.provide(f.serviceLayer));
  },
);

for (const childStatus of ["completed", "running"] as const) {
  it.effect(
    `completes when a failed child was resumed in its existing thread (${childStatus})`,
    () => {
      const f = fixture();
      const childId = ThreadId.make("delegated-child");
      f.projections.set(rootId, {
        ...f.projections.get(rootId)!,
        subagents: [{ ...child("builder"), origin: "app_owned", childThreadId: childId }],
      });
      const spawnRun = { ...run("child-spawn"), threadId: childId };
      f.projections.set(childId, { ...projection(childId), runs: [spawnRun] });
      return Effect.gen(function* () {
        const service = yield* UsageRecoveryService;
        yield* service.schedule(f.schedule);
        yield* TestClock.adjust("2 minutes");
        yield* service.reconcile();
        // The parent's task node keeps reporting its spawn run's quota failure.
        const at = yield* DateTime.now;
        f.projections.set(childId, {
          ...f.projections.get(childId)!,
          runs: [
            spawnRun,
            { ...run("child-resume", 2, childStatus), threadId: childId, requestedAt: at },
          ],
        });
        const p = f.projections.get(rootId)!;
        f.projections.set(rootId, {
          ...p,
          runs: p.runs.map((item) => ({ ...item, status: "completed" })),
        });
        yield* service.reconcile();
        const result = yield* service.get(rootId);
        assert.equal(result.recovery?.status, "completed");
        assert.isNull(result.eligibility);
        yield* TestClock.adjust("1 day");
        yield* service.reconcile();
        assert.lengthOf(f.commands, 1);
      }).pipe(Effect.provide(f.serviceLayer));
    },
  );
}

it.effect("completes without retrying a child the parent stopped on purpose", () => {
  const f = fixture();
  f.projections.set(rootId, {
    ...f.projections.get(rootId)!,
    subagents: [{ ...child("duplicate", "interrupted"), result: "Read the design doc." }],
  });
  return Effect.gen(function* () {
    const service = yield* UsageRecoveryService;
    yield* service.schedule(f.schedule);
    yield* TestClock.adjust("2 minutes");
    yield* service.reconcile();
    assert.include(f.commands[0]!.text, '"title": "duplicate"');
    const p = f.projections.get(rootId)!;
    f.projections.set(rootId, {
      ...p,
      runs: p.runs.map((item) => ({ ...item, status: "completed" })),
    });
    yield* service.reconcile();
    assert.equal((yield* service.get(rootId)).recovery?.status, "completed");
    yield* TestClock.adjust("1 hour");
    yield* service.reconcile();
    assert.lengthOf(f.commands, 1);
  }).pipe(Effect.provide(f.serviceLayer));
});

it.effect("tracks a replacement and does not repeat successful work", () => {
  const f = fixture();
  f.projections.set(rootId, { ...f.projections.get(rootId)!, subagents: [child("builder")] });
  return Effect.gen(function* () {
    const service = yield* UsageRecoveryService;
    yield* service.schedule(f.schedule);
    yield* TestClock.adjust("2 minutes");
    yield* service.reconcile();
    const p = f.projections.get(rootId)!;
    f.projections.set(rootId, {
      ...p,
      runs: p.runs.map((item) => ({ ...item, status: "completed" })),
      subagents: [
        ...p.subagents,
        {
          ...child("replacement", "completed"),
          prompt: recoveryMarker(f.schedule.commandId, "builder"),
          startedAt: yield* DateTime.now,
        },
      ],
    });
    yield* service.reconcile();
    assert.equal((yield* service.get(rootId)).recovery?.status, "completed");
    yield* TestClock.adjust("1 hour");
    yield* service.reconcile();
    assert.lengthOf(f.commands, 1);
  }).pipe(Effect.provide(f.serviceLayer));
});

for (const action of ["cancel", "message", "archive", "interrupt"] as const) {
  it.effect(`does not wake a thread after ${action}`, () => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* UsageRecoveryService;
      yield* service.schedule(f.schedule);
      const p = f.projections.get(rootId)!;
      if (action === "cancel") yield* service.cancel(rootId);
      if (action === "message")
        f.projections.set(rootId, {
          ...p,
          runs: [...p.runs, run("new-user-work", 2, "completed")],
        });
      if (action === "archive")
        f.projections.set(rootId, { ...p, thread: { ...p.thread, archivedAt: now } });
      if (action === "interrupt")
        f.projections.set(rootId, { ...p, runs: [{ ...p.runs[0]!, status: "interrupted" }] });
      yield* TestClock.adjust("3 minutes");
      yield* service.reconcile();
      assert.lengthOf(f.commands, 0);
      assert.equal((yield* service.get(rootId)).recovery?.status, "cancelled");
    }).pipe(Effect.provide(f.serviceLayer));
  });
}

it.effect(
  "recovers an overdue timer after restart and a crash after dispatch without duplicate messages",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* (yield* UsageRecoveryService).schedule(f.schedule);
      }).pipe(Effect.provide(layer));
      yield* TestClock.adjust("1 hour");
      yield* Effect.gen(function* () {
        const service = yield* UsageRecoveryService;
        yield* service.reconcile();
        assert.lengthOf(f.commands, 1);
        // Reproduce a crash before recording the post-dispatch phase in the timer row.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE usage_recovery SET status = 'scheduled', payload_json = json_set(payload_json, '$.status', 'scheduled', '$.attempts', 0)`;
      }).pipe(Effect.provide(layer));
      yield* Effect.gen(function* () {
        const service = yield* UsageRecoveryService;
        yield* service.reconcile();
        assert.lengthOf(f.commands, 1);
        assert.equal((yield* service.get(rootId)).recovery?.attempts, 1);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(f.deps));
  },
);

it("anchors relative resets to the failure time and leaves a one-minute margin", () => {
  assert.equal(
    recoveryRetryAt([{ text: "usage limit resets in 5 minutes", at: 0 }], 60_000),
    "1970-01-01T00:06:00.000Z",
  );
  assert.equal(
    recoveryRetryAt([{ text: "usage limit resets in 5 minutes", at: 0 }], 600_000),
    "1970-01-01T00:11:00.000Z",
  );
});

it.effect(
  "keeps tracking provider-native completion turns but never a newer user instruction",
  () => {
    const f = fixture();
    f.projections.set(rootId, { ...f.projections.get(rootId)!, subagents: [child("builder")] });
    return Effect.gen(function* () {
      const service = yield* UsageRecoveryService;
      yield* service.schedule(f.schedule);
      yield* TestClock.adjust("2 minutes");
      yield* service.reconcile();
      const p = f.projections.get(rootId)!;
      const at = yield* DateTime.now;
      const continuation = run("provider-continuation", 3, "completed");
      f.projections.set(rootId, {
        ...p,
        runs: [...p.runs.map((item) => ({ ...item, status: "completed" as const })), continuation],
        messages: [
          ...p.messages,
          {
            id: continuation.userMessageId,
            threadId: rootId,
            runId: continuation.id,
            nodeId: null,
            role: "user",
            text: "Background task completed.",
            attachments: [],
            streaming: false,
            createdAt: at,
            updatedAt: at,
            createdBy: "agent",
            creationSource: "provider",
          },
        ],
      });
      yield* service.reconcile();
      assert.equal((yield* service.get(rootId)).recovery?.status, "scheduled");
      const beforeUser = f.projections.get(rootId)!;
      f.projections.set(rootId, {
        ...beforeUser,
        messages: [
          ...beforeUser.messages,
          {
            ...beforeUser.messages.at(-1)!,
            id: MessageId.make("steering"),
            text: "Stop this work",
            createdBy: "user",
          },
        ],
      });
      yield* TestClock.adjust("2 minutes");
      yield* service.reconcile();
      assert.equal((yield* service.get(rootId)).recovery?.status, "cancelled");
      assert.lengthOf(f.commands, 1);
    }).pipe(Effect.provide(f.serviceLayer));
  },
);

it.effect("does not claim success on an unrelated provider failure", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* UsageRecoveryService;
    yield* service.schedule(f.schedule);
    yield* TestClock.adjust("2 minutes");
    yield* service.reconcile();
    const p = f.projections.get(rootId)!;
    f.projections.set(rootId, {
      ...p,
      runs: p.runs.map((item) => ({ ...item, status: "failed" })),
    });
    yield* service.reconcile();
    assert.equal((yield* service.get(rootId)).recovery?.status, "failed");
    yield* TestClock.adjust("2 minutes");
    yield* service.reconcile();
    assert.lengthOf(f.commands, 1);
  }).pipe(Effect.provide(f.serviceLayer));
});

it.effect("gives Codex its native child thread ID instead of the spawn tool call ID", () => {
  const f = fixture();
  const childId = ThreadId.make("codex-child");
  const parent = f.projections.get(rootId)!;
  const providerThread = {
    ...parent.providerThreads[0]!,
    driver: ProviderDriverKind.make("codex"),
  };
  f.projections.set(rootId, {
    ...parent,
    providerThreads: [providerThread],
    subagents: [
      {
        ...child("builder"),
        driver: ProviderDriverKind.make("codex"),
        childThreadId: childId,
        providerThreadId,
        nativeTaskRef: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "spawn-tool-call",
          strength: "strong",
        },
      },
    ],
  });
  f.projections.set(childId, {
    ...projection(childId),
    providerThreads: [
      {
        ...providerThread,
        appThreadId: childId,
        nativeThreadRef: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "codex-native-child-session",
          strength: "strong",
        },
      },
    ],
  });
  return Effect.gen(function* () {
    const service = yield* UsageRecoveryService;
    yield* service.schedule(f.schedule);
    yield* TestClock.adjust("2 minutes");
    yield* service.reconcile();
    assert.include(f.commands[0]!.text, '"nativeThreadId": "codex-native-child-session"');
    assert.include(f.commands[0]!.text, '"nativeTaskId": null');
    assert.notInclude(f.commands[0]!.text, "spawn-tool-call");
  }).pipe(Effect.provide(f.serviceLayer));
});

it.effect("includes unfinished children from earlier turns in the parent timer", () => {
  const f = fixture();
  const parent = f.projections.get(rootId)!;
  f.projections.set(rootId, {
    ...parent,
    runs: [{ ...parent.runs[0]!, requestedAt: DateTime.makeUnsafe(60_000) }],
    subagents: [{ ...child("older-builder"), runId: RunId.make("earlier-turn") }],
  });
  return Effect.gen(function* () {
    const service = yield* UsageRecoveryService;
    assert.equal((yield* service.get(rootId)).eligibility?.childCount, 1);
    yield* service.schedule(f.schedule);
    yield* TestClock.adjust("2 minutes");
    yield* service.reconcile();
    assert.include(f.commands[0]!.text, "native:older-builder");
  }).pipe(Effect.provide(f.serviceLayer));
});

for (const failure of ["before", "after"] as const) {
  it.effect(
    `handles a dispatch error ${failure} the message commits without duplicate retries`,
    () => {
      const f = fixture(failure);
      return Effect.gen(function* () {
        const service = yield* UsageRecoveryService;
        yield* service.schedule(f.schedule);
        yield* TestClock.adjust("2 minutes");
        yield* service.reconcile();
        const recovery = (yield* service.get(rootId)).recovery!;
        assert.equal(recovery.status, failure === "before" ? "failed" : "monitoring");
        assert.equal(recovery.attempts, 1);
        yield* TestClock.adjust("1 hour");
        yield* service.reconcile();
        assert.lengthOf(f.commands, failure === "before" ? 0 : 1);
      }).pipe(Effect.provide(f.serviceLayer));
    },
  );
}

function working(f: ReturnType<typeof fixture>, toolStatus: OrchestrationV2TurnItem["status"]) {
  const p = f.projections.get(rootId)!;
  const tool: OrchestrationV2TurnItem = {
    id: TurnItemId.make("tool"),
    type: "command_execution",
    threadId: rootId,
    runId: RunId.make("working"),
    nodeId: null,
    providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: toolStatus,
    title: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    input: "vp test run",
  };
  f.projections.set(rootId, {
    ...p,
    runs: [{ ...run("working", 1, "running"), completedAt: null }],
    turnItems: [tool],
  });
}
const pauseInput = {
  commandId: CommandId.make("pause-job"),
  threadId: rootId,
  resumeAt: "1970-01-01T00:02:00.000Z",
};

it.effect("pauses at the next step boundary and continues after the reset", () => {
  const f = fixture();
  working(f, "running");
  return Effect.gen(function* () {
    const service = yield* UsageRecoveryService;
    assert.isNull((yield* service.pause(pauseInput)).recovery?.pausedAt);
    yield* service.reconcile();
    assert.lengthOf(f.interrupts, 0, "a running tool call finishes first");
    working(f, "completed");
    yield* service.reconcile();
    assert.deepEqual(f.interrupts, [RunId.make("working")]);
    yield* service.reconcile();
    const paused = (yield* service.get(rootId)).recovery!;
    assert.equal(paused.status, "scheduled");
    assert.isString(paused.pausedAt);
    assert.lengthOf(f.commands, 0);
    yield* TestClock.adjust("2 minutes");
    yield* service.reconcile();
    assert.lengthOf(f.commands, 1);
    assert.include(f.commands[0]!.text, "paused this thread");
    assert.equal(f.commands[0]!.usageRecoveryOfRunId, RunId.make("working"));
  }).pipe(Effect.provide(f.serviceLayer));
});

it.effect("has nothing to resume when the turn finishes before the pause takes effect", () => {
  const f = fixture();
  working(f, "running");
  return Effect.gen(function* () {
    const service = yield* UsageRecoveryService;
    yield* service.pause(pauseInput);
    const p = f.projections.get(rootId)!;
    f.projections.set(rootId, { ...p, runs: [{ ...p.runs[0]!, status: "completed" }] });
    yield* service.reconcile();
    assert.equal((yield* service.get(rootId)).recovery?.status, "completed");
    yield* TestClock.adjust("2 minutes");
    yield* service.reconcile();
    assert.lengthOf(f.commands, 0);
    assert.lengthOf(f.interrupts, 0);
  }).pipe(Effect.provide(f.serviceLayer));
});

it.effect("compacts a large Claude session whose cache expired before resuming", () => {
  const f = fixture();
  working(f, "completed");
  const p = f.projections.get(rootId)!;
  f.projections.set(rootId, {
    ...p,
    providerThreads: p.providerThreads.map((thread) => ({
      ...thread,
      tokenUsage: { usedTokens: 150_000 },
    })),
  });
  return Effect.gen(function* () {
    const service = yield* UsageRecoveryService;
    yield* service.pause({ ...pauseInput, resumeAt: "1970-01-01T02:00:00.000Z" });
    yield* service.reconcile();
    yield* TestClock.adjust("2 hours");
    yield* service.reconcile();
    assert.lengthOf(f.commands, 1);
    assert.equal(f.commands[0]!.text, "/compact");
    yield* service.reconcile();
    assert.lengthOf(f.commands, 1, "waits for the compaction to finish");
    const compacting = f.projections.get(rootId)!;
    f.projections.set(rootId, {
      ...compacting,
      runs: compacting.runs.map((item) =>
        item.userMessageId === f.commands[0]!.messageId ? { ...item, status: "completed" } : item,
      ),
    });
    yield* service.reconcile();
    assert.lengthOf(f.commands, 2);
    assert.include(f.commands[1]!.text, "paused this thread");
    assert.equal((yield* service.get(rootId)).recovery?.status, "monitoring");
  }).pipe(Effect.provide(f.serviceLayer));
});

function withLargeClaudeContext(f: ReturnType<typeof fixture>) {
  const p = f.projections.get(rootId)!;
  f.projections.set(rootId, {
    ...p,
    providerThreads: p.providerThreads.map((thread) => ({
      ...thread,
      tokenUsage: { usedTokens: 150_000 },
    })),
  });
}

for (const failure of ["run", "error-item", "dispatch"] as const) {
  it.effect(`stops instead of resuming uncompacted when compaction fails (${failure})`, () => {
    const f = fixture(failure === "dispatch" ? "compact" : undefined);
    working(f, "completed");
    withLargeClaudeContext(f);
    return Effect.gen(function* () {
      const service = yield* UsageRecoveryService;
      yield* service.pause({ ...pauseInput, resumeAt: "1970-01-01T02:00:00.000Z" });
      yield* service.reconcile();
      yield* TestClock.adjust("2 hours");
      yield* service.reconcile();
      if (failure !== "dispatch") {
        assert.equal(f.commands[0]?.text, "/compact");
        const p = f.projections.get(rootId)!;
        const compactRun = p.runs.find((item) => item.userMessageId === f.commands[0]!.messageId)!;
        const settled = {
          ...p,
          runs: p.runs.map((item) =>
            item.id === compactRun.id
              ? {
                  ...item,
                  status: failure === "run" ? ("failed" as const) : ("completed" as const),
                }
              : item,
          ),
        };
        f.projections.set(
          rootId,
          failure === "run"
            ? settled
            : withFailure(settled, compactRun, yield* DateTime.now, "Compaction failed"),
        );
        // withFailure marks the run failed; an error item on a completed run must also stop.
        if (failure === "error-item")
          f.projections.set(rootId, {
            ...f.projections.get(rootId)!,
            runs: f.projections
              .get(rootId)!
              .runs.map((item) =>
                item.id === compactRun.id ? { ...item, status: "completed" as const } : item,
              ),
          });
      }
      yield* service.reconcile();
      yield* TestClock.adjust("1 hour");
      yield* service.reconcile();
      assert.isFalse(
        f.commands.some((command) => command.text !== "/compact"),
        "no continuation after a failed compaction",
      );
      const recovery = (yield* service.get(rootId)).recovery!;
      assert.equal(recovery.status, "failed");
      assert.include(recovery.message, "did not continue");
    }).pipe(Effect.provide(f.serviceLayer));
  });
}

it.effect("keeps a pause and its reset time across restarts", () => {
  const f = fixture();
  working(f, "running");
  const withService = <A, E>(
    body: (service: UsageRecoveryService["Service"]) => Effect.Effect<A, E>,
  ) => Effect.flatMap(UsageRecoveryService, body).pipe(Effect.provide(layer));
  return Effect.gen(function* () {
    yield* withService((service) => service.pause(pauseInput));
    working(f, "completed");
    yield* withService((service) => service.reconcile());
    assert.deepEqual(f.interrupts, [RunId.make("working")]);
    const paused = yield* withService((service) =>
      Effect.andThen(service.reconcile(), service.get(rootId)),
    );
    assert.isString(paused.recovery?.pausedAt);
    assert.equal(paused.recovery?.resumeAt, pauseInput.resumeAt);
    yield* withService((service) => service.reconcile());
    assert.lengthOf(f.commands, 0, "still paused before the reset");
    yield* TestClock.adjust("2 minutes");
    yield* withService((service) => Effect.andThen(service.reconcile(), service.reconcile()));
    yield* withService((service) => service.reconcile());
    assert.lengthOf(f.commands, 1);
    assert.include(f.commands[0]!.text, "paused this thread");
  }).pipe(Effect.provide(f.deps));
});

function paused(f: ReturnType<typeof fixture>) {
  working(f, "completed");
  return Effect.gen(function* () {
    const service = yield* UsageRecoveryService;
    yield* service.pause(pauseInput);
    yield* service.reconcile();
    yield* service.reconcile();
    assert.isString((yield* service.get(rootId)).recovery?.pausedAt);
    return service;
  });
}

it.effect("cancelling while the step finishes leaves the running turn alone", () => {
  const f = fixture();
  working(f, "running");
  return Effect.gen(function* () {
    const service = yield* UsageRecoveryService;
    yield* service.pause(pauseInput);
    yield* service.cancel(rootId);
    working(f, "completed");
    yield* service.reconcile();
    yield* TestClock.adjust("3 minutes");
    yield* service.reconcile();
    assert.lengthOf(f.interrupts, 0);
    assert.lengthOf(f.commands, 0);
    assert.equal(f.projections.get(rootId)!.runs[0]!.status, "running");
    assert.equal((yield* service.get(rootId)).recovery?.status, "cancelled");
  }).pipe(Effect.provide(f.serviceLayer));
});

it.effect("a new message while paused ends the pause without a continuation", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* paused(f);
    yield* TestClock.adjust("1 minute");
    const p = f.projections.get(rootId)!;
    const at = yield* DateTime.now;
    const next = { ...run("user-follow-up", 2, "running"), requestedAt: at };
    f.projections.set(rootId, {
      ...p,
      runs: [...p.runs, next],
      messages: [
        ...p.messages,
        {
          id: next.userMessageId,
          threadId: rootId,
          runId: next.id,
          nodeId: null,
          role: "user",
          text: "Actually, do this instead",
          attachments: [],
          streaming: false,
          createdAt: at,
          updatedAt: at,
          createdBy: "user",
          creationSource: "web",
        },
      ],
    });
    yield* TestClock.adjust("2 minutes");
    yield* service.reconcile();
    yield* service.reconcile();
    assert.lengthOf(f.commands, 0);
    assert.lengthOf(f.interrupts, 1, "the newer turn is never interrupted");
    assert.equal((yield* service.get(rootId)).recovery?.status, "cancelled");
  }).pipe(Effect.provide(f.serviceLayer));
});

it.effect("repeated resume-now requests and ticks send one continuation", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* paused(f);
    const resumeNow = (id: string) =>
      service.schedule({
        ...f.schedule,
        commandId: CommandId.make(id),
        resumeAt: "1970-01-01T00:00:00.000Z",
      });
    yield* Effect.all([resumeNow("resume-a"), resumeNow("resume-b"), service.reconcile()], {
      concurrency: "unbounded",
    });
    yield* Effect.all([service.reconcile(), service.reconcile()], { concurrency: "unbounded" });
    yield* TestClock.adjust("1 hour");
    yield* service.reconcile();
    assert.lengthOf(f.commands, 1);
    assert.equal((yield* service.get(rootId)).recovery?.status, "monitoring");
  }).pipe(Effect.provide(f.serviceLayer));
});

it.effect("cancelling after resume-now but before the tick sends nothing", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* paused(f);
    yield* service.schedule({ ...f.schedule, resumeAt: "1970-01-01T00:00:00.000Z" });
    yield* service.cancel(rootId);
    yield* service.reconcile();
    yield* TestClock.adjust("1 hour");
    yield* service.reconcile();
    assert.lengthOf(f.commands, 0);
    assert.equal((yield* service.get(rootId)).recovery?.status, "cancelled");
  }).pipe(Effect.provide(f.serviceLayer));
});
