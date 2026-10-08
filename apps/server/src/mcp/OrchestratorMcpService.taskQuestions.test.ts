import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

import { openTaskQuestions, resolveDelegatedRuntimeMode } from "./OrchestratorMcpService.ts";

const now = DateTime.makeUnsafe("2026-10-08T12:00:00.000Z");
const threadId = ThreadId.make("thread-child");

function question(input: {
  readonly id: string;
  readonly status?: OrchestrationV2RuntimeRequest["status"];
  readonly kind?: OrchestrationV2RuntimeRequest["kind"];
  readonly isSecret?: boolean;
  readonly notResumable?: boolean;
}): {
  readonly request: OrchestrationV2RuntimeRequest;
  readonly item: OrchestrationV2TurnItem;
} {
  const requestId = RuntimeRequestId.make(input.id);
  const nodeId = NodeId.make(`node-${input.id}`);
  return {
    request: {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: input.kind ?? "user_input",
      status: input.status ?? "pending",
      isBlocking: false,
      responseCapability: input.notResumable
        ? { type: "not_resumable", reason: "Provider conversation ended." }
        : { type: "message", providerThreadId: ProviderThreadId.make("provider-thread-child") },
      createdAt: now,
      resolvedAt: null,
    },
    item: {
      id: TurnItemId.make(`item-${input.id}`),
      threadId,
      runId: null,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "waiting",
      title: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "user_input_request",
      requestId,
      questions: [
        {
          id: "question-1",
          header: "Question",
          question: "The lockfile is outside your allowlist. May I keep the generated update?",
          isOther: true,
          ...(input.isSecret === undefined ? {} : { isSecret: input.isSecret }),
          options: [
            { label: "Keep it", description: "Keep it" },
            { label: "Restore it", description: "Restore it" },
          ],
        },
      ],
    },
  };
}

function projectionOf(...questions: ReadonlyArray<ReturnType<typeof question>>) {
  return {
    runtimeRequests: questions.map((entry) => entry.request),
    turnItems: questions.map((entry) => entry.item),
  };
}

describe("openTaskQuestions", () => {
  it("offers a delegated child's open question to its parent", () => {
    expect(openTaskQuestions(projectionOf(question({ id: "ask-1" })))).toEqual([
      {
        requestId: RuntimeRequestId.make("ask-1"),
        questions: [
          {
            id: "question-1",
            question: "The lockfile is outside your allowlist. May I keep the generated update?",
            options: ["Keep it", "Restore it"],
          },
        ],
      },
    ]);
  });

  it("leaves out answered, unresumable, secret, and non-question requests", () => {
    expect(
      openTaskQuestions(
        projectionOf(
          question({ id: "answered", status: "resolved" }),
          question({ id: "stale", notResumable: true }),
          question({ id: "secret", isSecret: true }),
          question({ id: "approval", kind: "command" }),
        ),
      ),
    ).toEqual([]);
  });
});

describe("resolveDelegatedRuntimeMode", () => {
  it.effect("runs every child of a full-access parent with full access", () =>
    Effect.gen(function* () {
      expect(yield* resolveDelegatedRuntimeMode("full-access", "approval-required")).toBe(
        "full-access",
      );
      expect(yield* resolveDelegatedRuntimeMode("full-access", undefined)).toBe("full-access");
    }),
  );

  it.effect("still lets a narrower parent hand down its own mode or less", () =>
    Effect.gen(function* () {
      expect(yield* resolveDelegatedRuntimeMode("auto", "inherit")).toBe("auto");
      expect(yield* resolveDelegatedRuntimeMode("auto", "approval-required")).toBe(
        "approval-required",
      );
      const escalation = yield* Effect.flip(
        resolveDelegatedRuntimeMode("approval-required", "full-access"),
      );
      expect(escalation.code).toBe("runtime_mode_escalation_denied");
    }),
  );
});

const parentThreadId = ThreadId.make("thread-parent");
const taskId = NodeId.make("task-question");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-questions"),
  threadId: parentThreadId,
  providerSessionId: "session-parent",
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerDriverKind: ProviderDriverKind.make("codex"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const answerInput = {
  taskId,
  requestId: RuntimeRequestId.make("ask-1"),
  answers: { "question-1": ["Keep it", "Restore it"] },
  clientRequestId: "answer-1",
};

function answerTestLayer(input: {
  readonly request?: OrchestrationV2RuntimeRequest;
  readonly secret?: boolean;
  readonly origin?: "app_owned" | "provider_native";
  readonly dispatch: ThreadManagementService["Service"]["dispatch"];
}) {
  const parent = {
    thread: { id: parentThreadId },
    runs: [],
    contextTransfers: [],
    subagents: [
      {
        id: taskId,
        threadId: parentThreadId,
        origin: input.origin ?? "app_owned",
        childThreadId: threadId,
        result: "Child asked a question.",
        completionDelivery: { state: "acknowledged" },
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const entry = question({
    id: "ask-1",
    ...(input.secret === undefined ? {} : { isSecret: input.secret }),
  });
  const child = {
    thread: { id: threadId },
    contextTransfers: [],
    runs: [],
    runtimeRequests: [input.request ?? entry.request],
    turnItems: [entry.item],
  } as unknown as OrchestrationV2ThreadProjection;
  return OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService)({
          getThreadProjection: (id) =>
            Effect.succeed(
              id === parentThreadId
                ? parent
                : id === threadId
                  ? child
                  : { ...parent, subagents: [] },
            ),
          dispatch: input.dispatch,
        }),
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ScheduledTaskService)({}),
      ),
    ),
  );
}

describe("answerTask", () => {
  it.effect("replays its resolved answer with the same command id", () => {
    const commandId = CommandId.make("command:mcp:session-parent:answer-task:answer-1");
    const commands: Array<OrchestrationV2Command> = [];
    const layer = answerTestLayer({
      request: {
        ...question({ id: "ask-1" }).request,
        status: "resolved",
        responseCommandId: commandId,
      },
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return {} as never;
        }),
    });
    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const first = yield* service.answerTask(scope, answerInput);
      expect(yield* service.answerTask(scope, answerInput)).toEqual(first);
      expect(commands).toHaveLength(2);
      expect(commands.every((command) => command.commandId === commandId)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps acknowledged tasks answerable and sends multi-select answers as agent", () => {
    const commands: Array<OrchestrationV2Command> = [];
    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      yield* service.answerTask(scope, answerInput);
      expect(commands).toEqual([
        expect.objectContaining({
          type: "runtime-request.respond",
          threadId,
          answeredBy: "agent",
          answers: answerInput.answers,
        }),
      ]);
    }).pipe(
      Effect.provide(
        answerTestLayer({
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              return {} as never;
            }),
        }),
      ),
    );
  });

  for (const answers of [undefined, " ", [], ["Keep it", " "], [" "]]) {
    it.effect(`rejects incomplete answers before dispatch: ${JSON.stringify(answers)}`, () =>
      Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .answerTask(scope, {
            ...answerInput,
            answers: answers === undefined ? {} : { "question-1": answers },
          })
          .pipe(Effect.flip);
        expect(error.code).toBe("invalid_request");
      }).pipe(
        Effect.provide(answerTestLayer({ dispatch: () => Effect.die("Must not dispatch.") })),
      ),
    );
  }

  it.effect("preserves the reason a response cannot resume its conversation", () =>
    Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const error = yield* service.answerTask(scope, answerInput).pipe(Effect.flip);
      expect(error.code).toBe("question_not_answerable");
      expect(error.message).toContain("Restore that conversation before answering.");
    }).pipe(
      Effect.provide(
        answerTestLayer({
          dispatch: (command) =>
            Effect.fail(
              new OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause:
                  "This question belongs to a previous provider conversation. Restore that conversation before answering.",
              }),
            ),
        }),
      ),
    ),
  );

  it.effect("denies foreign tasks and missing capabilities before dispatch", () =>
    Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const foreign = yield* service
        .answerTask({ ...scope, threadId: ThreadId.make("stranger") }, answerInput)
        .pipe(Effect.flip);
      expect(foreign.code).toBe("task_not_found");
      const denied = yield* service
        .answerTask({ ...scope, capabilities: new Set() }, answerInput)
        .pipe(Effect.flip);
      expect(denied.code).toBe("capability_denied");
    }).pipe(Effect.provide(answerTestLayer({ dispatch: () => Effect.die("Must not dispatch.") }))),
  );

  it.effect("does not replay a question resolved by another command", () =>
    Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const error = yield* service.answerTask(scope, answerInput).pipe(Effect.flip);
      expect(error.code).toBe("question_not_answerable");
    }).pipe(
      Effect.provide(
        answerTestLayer({
          request: {
            ...question({ id: "ask-1" }).request,
            status: "resolved",
            responseCommandId: CommandId.make("someone-else"),
          },
          dispatch: () => Effect.die("Must not dispatch."),
        }),
      ),
    ),
  );
});

for (const [name, options, code] of [
  ["secret questions", { secret: true }, "question_not_answerable"],
  ["provider-native tasks", { origin: "provider_native" }, "task_not_found"],
  [
    "unresumable questions",
    { request: question({ id: "ask-1", notResumable: true }).request },
    "question_not_answerable",
  ],
] as const) {
  it.effect(`answerTask refuses ${name}`, () =>
    Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const error = yield* service.answerTask(scope, answerInput).pipe(Effect.flip);
      expect(error.code).toBe(code);
    }).pipe(
      Effect.provide(
        answerTestLayer({ ...options, dispatch: () => Effect.die("Must not dispatch.") }),
      ),
    ),
  );
}
