import { executionOrigin } from "./orchestratorExecution.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import {
  ThreadId,
  ProviderInstanceId,
  RunId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  PositiveInt,
  NonNegativeInt,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2Command,
  type OrchestrationV2Subagent,
} from "@spiritdevs/contracts";
import { reconcileOwnedStop } from "./conversationStop.ts";
const assignment = { workId: "work", commandId: "origin", orchestratorId: "coordinator" };
const now = DateTime.makeUnsafe("2026-09-14T00:00:00Z");
function projection(id = "root"): OrchestrationV2ThreadProjection {
  const threadId = ThreadId.make(id),
    instanceId = ProviderInstanceId.make("codex");
  return {
    thread: {
      id: threadId,
      projectId: null,
      title: "Worker",
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "test" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        rootThreadId: ThreadId.make("root"),
        parentThreadId: id === "root" ? null : ThreadId.make("root"),
        relationshipToParent: id === "root" ? null : "subagent",
      },
      forkedFrom: null,
      createdBy: "agent",
      creationSource: "mcp",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
      orchestratorOrigin: { ...assignment, companyId: "company", commandId: assignment.commandId },
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: now,
  };
}

function withRun(id: string, status: "running" | "completed" | "queued" = "running") {
  const p = projection(id);
  const runId = RunId.make(id + ":run");
  const messageId = MessageId.make(id + ":message");
  return {
    ...p,
    runs: [
      {
        id: runId,
        threadId: p.thread.id,
        ordinal: PositiveInt.make(1),
        providerInstanceId: p.thread.providerInstanceId,
        modelSelection: p.thread.modelSelection,
        providerThreadId: null,
        userMessageId: messageId,
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    messages: [
      {
        id: messageId,
        threadId: p.thread.id,
        runId,
        nodeId: null,
        role: "user" as const,
        text: "Task",
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
        createdBy: "user" as const,
        creationSource: "web" as const,
      },
    ],
  };
}
function childTask(
  parent: ReturnType<typeof withRun>,
  child: ReturnType<typeof withRun> | null,
): OrchestrationV2Subagent {
  return {
    id: NodeId.make("task"),
    threadId: parent.thread.id,
    runId: parent.runs[0]!.id,
    parentNodeId: NodeId.make("node"),
    origin: child ? "app_owned" : "provider_native",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: parent.thread.providerInstanceId,
    providerThreadId: null,
    childThreadId: child?.thread.id ?? null,
    nativeTaskRef: null,
    prompt: "Task",
    title: null,
    model: null,
    status: "running",
    result: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
}
function services(rows: OrchestrationV2ThreadProjection[]) {
  const commands: OrchestrationV2Command[] = [];
  return {
    commands,
    threads: {
      dispatch: (command: OrchestrationV2Command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: NonNegativeInt.make(0), storedEvents: [] };
        }),
      getThreadProjection: (id: ThreadId) =>
        Effect.succeed(rows.find((row) => row.thread.id === id)!),
    },
  };
}
describe("owned conversation stop", () => {
  it.effect(
    "targets a queued owned run and descendants without interrupting unrelated runs on a reused thread",
    () =>
      Effect.gen(function* () {
        const child = withRun("child");
        const owned = withRun("root", "queued");
        const unrelated = withRun("unrelated");
        const root = {
          ...owned,
          runs: [...owned.runs, ...unrelated.runs],
          subagents: [childTask(owned, child)],
        };
        const test = services([root, child]);
        const receipt = yield* reconcileOwnedStop(test.threads, root, "stop", "root:message");
        expect(receipt.confirmed).toBe(false);
        expect(test.commands.map((c) => c.type)).toEqual(["queued-run.cancel", "run.interrupt"]);
        expect(test.commands.every((c) => "runId" in c && c.runId !== unrelated.runs[0]!.id)).toBe(
          true,
        );
      }),
  );
  it.effect(
    "does not confuse dispatch acceptance with termination; a later terminal projection confirms",
    () =>
      Effect.gen(function* () {
        const root = withRun("root");
        const test = services([root]);
        expect((yield* reconcileOwnedStop(test.threads, root, "stop")).confirmed).toBe(false);
        expect(
          (yield* reconcileOwnedStop(test.threads, withRun("root", "completed"), "stop")).confirmed,
        ).toBe(true);
      }),
  );
  it.effect("retains uncertainty for missing targets and synthetic native interruption", () =>
    Effect.gen(function* () {
      const root = withRun("root", "completed");
      const test = services([root]);
      expect((yield* reconcileOwnedStop(test.threads, root, "stop", "absent")).confirmed).toBe(
        false,
      );
      const native = {
        ...root,
        subagents: [{ ...childTask(root, null), status: "interrupted" as const }],
      };
      expect((yield* reconcileOwnedStop(test.threads, native, "stop")).confirmed).toBe(false);
      expect(test.commands).toEqual([]);
    }),
  );
  it.effect("stops a terminal parent's open completion cohort before confirming it", () =>
    Effect.gen(function* () {
      const root = { ...withRun("root", "completed") };
      const p = {
        ...root,
        runs: root.runs.map((run) => ({
          ...run,
          delegatedCompletion: {
            disposition: "open" as const,
            nextGeneration: PositiveInt.make(1),
            delivery: null,
          },
        })),
      };
      const test = services([p]);
      expect((yield* reconcileOwnedStop(test.threads, p, "stop")).confirmed).toBe(false);
      expect(test.commands[0]?.type).toBe("run.interrupt");
    }),
  );
});

it.effect(
  "attributes a child's allowance to its owning parent run despite a different active run",
  () =>
    Effect.gen(function* () {
      const owned = withRun("root", "completed");
      const newer = withRun("other");
      const child = withRun("child");
      const root = {
        ...owned,
        runs: [...owned.runs, ...newer.runs],
        messages: [...owned.messages, ...newer.messages],
        subagents: [childTask(owned, child)],
      };
      const test = services([root, child]);
      const origin = yield* executionOrigin(test.threads.getThreadProjection, child.thread.id, {
        companyId: "company",
        orchestratorId: "coordinator",
        commandId: "origin",
      });
      expect(origin.execution).toEqual({
        threadId: "root",
        runId: "root:run",
        messageId: "root:message",
      });
      const direct = yield* executionOrigin(test.threads.getThreadProjection, root.thread.id, {
        companyId: "company",
        orchestratorId: "coordinator",
        commandId: "origin",
      });
      expect(direct.execution?.runId).toBe("other:run");
    }),
);
