import { describe, expect, it } from "@effect/vitest";
import {
  NodeId,
  ProviderThreadId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

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
