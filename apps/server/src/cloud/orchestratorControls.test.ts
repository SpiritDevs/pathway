import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  ThreadId,
  ProviderInstanceId,
  RuntimeRequestId,
  NodeId,
  ProviderThreadId,
  CommandId,
  NonNegativeInt,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2Command,
} from "@spiritdevs/contracts";
import {
  executeAcceptedWorkerMessage,
  reportWorkerQuestionChanges,
  workerControlRetryWakeups,
  belongsToWorker,
  workerMessageCommandId,
} from "./orchestratorControls.ts";
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
function harness(problem: "normal" | "foreign" | "approval" | "stale" = "normal") {
  const root = projection();
  const base = projection("child");
  const child: OrchestrationV2ThreadProjection = {
    ...base,
    thread: {
      ...base.thread,
      orchestratorOrigin: {
        ...base.thread.orchestratorOrigin!,
        commandId: problem === "foreign" ? "foreign" : assignment.commandId,
      },
    },
    runtimeRequests:
      problem === "stale"
        ? []
        : [
            {
              id: RuntimeRequestId.make("question"),
              nodeId: NodeId.make("node"),
              providerTurnId: null,
              nativeRequestRef: null,
              kind: problem === "approval" ? "command" : "user_input",
              status: "pending",
              responseCapability: {
                type: "message",
                providerThreadId: ProviderThreadId.make("provider-thread"),
              },
              createdAt: now,
              resolvedAt: null,
            },
          ],
  };
  const commands: OrchestrationV2Command[] = [];
  let recorded = false,
    allow = true;
  const message = {
    id: "answer",
    threadId: "child",
    mode: "answer" as const,
    text: "",
    requestId: "question",
    answers: { format: "JSON" },
  };
  const input = {
    message,
    assignment,
    root,
    companyId: "company",
    admit: () => Effect.sync(() => allow),
    receipts: {
      getByCommandId: (commandId: CommandId) =>
        Effect.sync(() =>
          recorded
            ? Option.some({
                commandId,
                threadId: child.thread.id,
                commandType: "runtime-request.respond",
                acceptedAt: now,
                resultSequence: NonNegativeInt.make(1),
                status: "accepted" as const,
                error: null,
              })
            : Option.none(),
        ),
    },
    threads: {
      getThreadProjection: () => Effect.succeed(child),
      dispatch: (command: OrchestrationV2Command) =>
        Effect.sync(() => {
          commands.push(command);
          recorded = true;
          return { sequence: 1, storedEvents: [] };
        }),
      sendToThread: () => Effect.die("Unexpected new turn"),
    },
  };
  return {
    input,
    commands,
    child,
    hold: () => {
      allow = false;
    },
  };
}
describe("worker control local delivery", () => {
  it.effect(
    "routes an answer to the original child and reuses its receipt after a lost acknowledgment",
    () =>
      Effect.gen(function* () {
        const test = harness();
        expect((yield* executeAcceptedWorkerMessage(test.input)).failed).toBe(false);
        expect(test.commands).toHaveLength(1);
        expect(test.commands[0]).toMatchObject({
          type: "runtime-request.respond",
          threadId: "child",
          requestId: "question",
          answeredBy: "agent",
          answers: { format: "JSON" },
        });
        test.hold();
        expect(
          (yield* executeAcceptedWorkerMessage({ ...test.input, recoveryOnly: true })).failed,
        ).toBe(false);
        expect(test.commands).toHaveLength(1);
      }),
  );
  it.effect("refuses foreign descendants and approval requests", () =>
    Effect.gen(function* () {
      const foreign = harness("foreign");
      expect((yield* executeAcceptedWorkerMessage(foreign.input)).failed).toBe(true);
      expect(foreign.commands).toHaveLength(0);
      const approval = harness("approval");
      expect((yield* executeAcceptedWorkerMessage(approval.input)).failed).toBe(true);
      expect(approval.commands).toHaveLength(0);
    }),
  );
  it.effect("holds accepted delivery under descendant allowance without dispatching", () =>
    Effect.gen(function* () {
      const test = harness();
      test.hold();
      expect((yield* executeAcceptedWorkerMessage(test.input).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(test.commands).toHaveLength(0);
    }),
  );
  it.effect("does not manufacture a new turn for stale questions or idle steering", () =>
    Effect.gen(function* () {
      const test = harness("stale");
      expect((yield* executeAcceptedWorkerMessage(test.input)).failed).toBe(true);
      expect(
        (yield* executeAcceptedWorkerMessage({
          ...test.input,
          message: { ...test.input.message, mode: "steer" },
        })).failed,
      ).toBe(true);
      expect(test.commands).toHaveLength(0);
    }),
  );
  it("requires exact assignment origin and separates ambiguous id pairs", () => {
    expect(belongsToWorker(projection(), assignment, "other-company")).toBe(false);
    expect(workerMessageCommandId("a:b", "c")).not.toBe(workerMessageCommandId("a", "b:c"));
  });
});

it("accepts an explicitly assigned continuation or adopted root while checking descendant origin", () => {
  const root = projection();
  const continued = { ...assignment, threadId: "root", commandId: "new-followup-command" };
  expect(belongsToWorker(root, continued, "company")).toBe(true);
  expect(
    belongsToWorker(
      { ...root, thread: { ...root.thread, orchestratorOrigin: undefined } },
      continued,
      "company",
    ),
  ).toBe(true);
  expect(belongsToWorker(projection("child"), continued, "company", root)).toBe(true);
  expect(
    belongsToWorker(
      projection("child"),
      { ...continued, orchestratorId: "foreign" },
      "company",
      root,
    ),
  ).toBe(false);
});

it.effect(
  "recovers the original message for a native answer without a synthetic answer message",
  () =>
    Effect.gen(function* () {
      const test = harness();
      const child = {
        ...test.child,
        messages: [{ id: "original-user-message", role: "user", runId: "native-run" }],
        turnItems: [
          { type: "user_input_request", requestId: "question", runId: "native-run", questions: [] },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const input = {
        ...test.input,
        threads: { ...test.input.threads, getThreadProjection: () => Effect.succeed(child) },
      };
      const first = yield* executeAcceptedWorkerMessage(input);
      expect(first).toMatchObject({ runId: "native-run", messageId: "original-user-message" });
      test.hold();
      const recovered = yield* executeAcceptedWorkerMessage({ ...input, recoveryOnly: true });
      expect(recovered).toMatchObject({ runId: "native-run", messageId: "original-user-message" });
      expect(test.commands).toHaveLength(1);
    }),
);

it.effect("reports each question opening and closure once across repeated thread events", () =>
  Effect.gen(function* () {
    const test = harness();
    const child = {
      ...test.child,
      turnItems: [
        {
          type: "user_input_request",
          requestId: "question",
          questions: [
            {
              id: "format",
              question: "Which format?",
              options: [],
              multiSelect: false,
              isOther: false,
            },
          ],
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const reported = new Map<string, boolean>();
    const reports: boolean[] = [];
    const input = {
      projection: child,
      workId: "work",
      reported,
      report: (question: { open: boolean }) =>
        Effect.sync(() => {
          reports.push(question.open);
        }),
    };
    yield* reportWorkerQuestionChanges(input);
    yield* reportWorkerQuestionChanges(input);
    const closed = {
      ...child,
      runtimeRequests: child.runtimeRequests.map((request) => ({
        ...request,
        status: "resolved" as const,
      })),
    };
    yield* reportWorkerQuestionChanges({ ...input, projection: closed });
    yield* reportWorkerQuestionChanges({ ...input, projection: closed });
    expect(reports).toEqual([true, false]);
  }),
);

it.effect(
  "retries unconfirmed assignments without another thread event and stops after recovery",
  () =>
    Effect.gen(function* () {
      const pending = new Map<
        string,
        {
          workId: string;
          commandId: string;
          orchestratorId: string;
          threadId: string;
          allowanceRevision: string;
          stopped: boolean;
          cancellationRequested: boolean;
          stopMessageId: string | null;
          stopRunId: string | null;
          message: { id: string; revision: number };
        }
      >();
      const wakeups: string[][] = [];
      const fiber = yield* workerControlRetryWakeups(pending).pipe(
        Stream.runForEach(({ rows }) =>
          Effect.sync(() => {
            wakeups.push(rows.map((row) => row.workId));
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      pending.set("work", {
        ...assignment,
        threadId: "root",
        allowanceRevision: "",
        stopped: false,
        cancellationRequested: false,
        stopMessageId: null,
        stopRunId: null,
        message: { id: "unconfirmed", revision: 0 },
      });
      yield* TestClock.adjust("15 seconds");
      expect(wakeups).toEqual([["work"]]);
      yield* TestClock.adjust("15 seconds");
      expect(wakeups).toHaveLength(2);
      pending.delete("work");
      yield* TestClock.adjust("30 seconds");
      expect(wakeups).toHaveLength(2);
      yield* Fiber.interrupt(fiber);
    }),
);
