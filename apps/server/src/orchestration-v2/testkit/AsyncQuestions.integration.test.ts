import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind } from "@spiritdevs/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { CodexAppServerReplayEntry } from "effect-codex-app-server/replay";
import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import {
  CODEX_MODEL_SELECTION,
  materializeFixtureInput,
  PLAN_QUESTIONS_PROMPT,
  READ_ONLY_NEVER_POLICY,
} from "./fixtures/shared.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./ProviderReplayHarness.ts";
import type { OrchestratorV2ScenarioStep } from "./OrchestratorScenario.ts";
import { checkpointWorkspace } from "./ReplayFixtureWorkspace.ts";
import {
  decodeProviderReplayNdjson,
  materializeReplayTranscriptWorkspace,
} from "./ReplayTranscriptNdjson.ts";

for (const delivery of ["active", "idle", "steer-race"] as const) {
  const answerAfterCompletion = delivery === "idle";
  const steerRejected = delivery === "steer-race";
  it.effect(
    steerRejected
      ? "delivers a follow-up when Codex rejects steering after its turn ended"
      : answerAfterCompletion
        ? "starts a same-conversation follow-up for an answer after completion"
        : "atomically saves an async answer, steers it, and ignores replay after resolution",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const raw = yield* decodeProviderReplayNdjson(
          yield* fs.readFileString(
            new URL("./fixtures/plan_questions/codex_transcript.ndjson", import.meta.url).pathname,
          ),
        );
        const workspace = yield* checkpointWorkspace("async_questions");
        const source = yield* CodexOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptWorkspace(raw, workspace),
        );
        const nativeThreadId = "019db22a-e824-7ac3-bbf7-994a4aa087e5";
        const nativeTurnId = "019db22a-e831-7b60-82fd-9eb12d353264";
        const question: CodexAppServerReplayEntry = {
          type: "emit_inbound",
          label: "async question",
          frame: {
            method: "item/completed",
            params: {
              threadId: nativeThreadId,
              turnId: nativeTurnId,
              item: {
                type: "agentMessage",
                id: "async-question",
                text: "",
                phase: "final_answer",
                delivery: "async",
                questions: [
                  { title: "Which approach?", options: ["Strict schemas", "UI flexibility"] },
                ],
              },
            },
          },
        };
        const answerText = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          request_user_input_async: "async-question",
          answers: [{ question: "Which approach?", answer: "Strict schemas" }],
        });
        const entries = source.entries.flatMap(
          (entry): ReadonlyArray<CodexAppServerReplayEntry> => {
            if ((answerAfterCompletion || steerRejected) && entry.type === "runtime_exit")
              return [];
            if (entry.type === "runtime_exit" || entry.label !== "item/tool/requestUserInput")
              return [entry];
            if (entry.type === "emit_inbound") return [question, question];
            if (answerAfterCompletion) return [];
            return [
              {
                type: "expect_outbound",
                label: "answer as steering message",
                frame: {
                  id: 4,
                  method: "turn/steer",
                  params: {
                    threadId: nativeThreadId,
                    expectedTurnId: nativeTurnId,
                    input: [{ type: "text", text: answerText }],
                  },
                },
              },
              {
                type: "emit_inbound",
                label: "answer accepted",
                frame: steerRejected
                  ? { id: 4, error: { code: -32600, message: "no active turn" } }
                  : { id: 4, result: { turnId: nativeTurnId } },
              },
              question,
            ];
          },
        );
        if (answerAfterCompletion || steerRejected) {
          const start = source.entries.find(
            (entry) => entry.type === "expect_outbound" && entry.label === "turn/start",
          );
          if (start?.type !== "expect_outbound")
            return yield* Effect.die("Missing turn/start fixture.");
          const startFrame = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ params: Schema.Record(Schema.String, Schema.Unknown) }),
          )(start.frame);
          const nextTurn = {
            id: "async-answer-turn",
            items: [],
            status: "inProgress",
            error: null,
            startedAt: 1776810658,
            completedAt: null,
            durationMs: null,
          };
          entries.push(
            {
              type: "expect_outbound",
              label: "answer follow-up",
              frame: {
                id: steerRejected ? 5 : 4,
                method: "turn/start",
                params: { ...startFrame.params, input: [{ type: "text", text: answerText }] },
              },
            },
            {
              type: "emit_inbound",
              label: "answer turn accepted",
              frame: { id: steerRejected ? 5 : 4, result: { turn: nextTurn } },
            },
            {
              type: "emit_inbound",
              label: "answer response",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nextTurn.id,
                  item: {
                    type: "agentMessage",
                    id: "answer-final",
                    text: "Answer received.",
                    phase: "final_answer",
                    memoryCitation: null,
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "answer turn completed",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: {
                    ...nextTurn,
                    status: "completed",
                    completedAt: 1776810659,
                    durationMs: 1000,
                  },
                },
              },
            },
            { type: "runtime_exit", status: "success" },
          );
        }
        const materialized = yield* materializeFixtureInput({
          scenario: "async_questions",
          fixtureInput: {
            interactionMode: "plan",
            steps: [
              { type: "message", text: PLAN_QUESTIONS_PROMPT },
              {
                type: "answer_next_user_input_request",
                answers: { "question-1": "Strict schemas" },
              },
            ],
          },
          driver: ProviderDriverKind.make("codex"),
          modelSelection: CODEX_MODEL_SELECTION,
        }).pipe(Effect.provide(idAllocatorLayer), provideDeterministicTestRuntime);
        const result = yield* runOrchestratorV2ProviderReplayScenario(
          {
            name: "async_questions",
            transcript: { ...source, scenario: "async_questions", entries },
            commands: materialized.commands,
            steps: answerAfterCompletion
              ? materialized.steps.flatMap<OrchestratorV2ScenarioStep>((step) =>
                  step.type === "respond_to_next_runtime_request"
                    ? [{ type: "await_thread_idle" as const, threadId: step.threadId }, step]
                    : [step],
                )
              : materialized.steps,
            projectionThreadIds: materialized.projectionThreadIds,
            runtimePolicyOverride: { ...READ_ONLY_NEVER_POLICY, cwd: workspace },
          },
          CodexOrchestratorReplayHarness,
        ).pipe(provideDeterministicTestRuntime);
        const projection = result.projections.get(materialized.projectionThreadIds[0]!);
        assert.isDefined(projection);
        if (projection === undefined) return;
        assert.equal(projection.runtimeRequests.length, 1);
        assert.equal(projection.runtimeRequests[0]?.status, "resolved");
        assert.equal(projection.runtimeRequests[0]?.isBlocking, false);
        assert.equal(projection.runs.length, answerAfterCompletion || steerRejected ? 2 : 1);
        assert.equal(new Set(projection.runs.map((run) => run.providerThreadId)).size, 1);
        const answerMessages = projection.messages.filter((message) => message.text === answerText);
        assert.equal(answerMessages.length, 1);
        assert.equal(projection.runtimeRequests[0]?.responseMessageId, answerMessages[0]?.id);
        const requestEvents = result.domainEvents.filter(
          (event) => event.type === "runtime-request.updated",
        );
        assert.deepEqual(
          requestEvents.map((event) => event.payload.status),
          steerRejected ? ["pending", "resolved", "resolved"] : ["pending", "resolved"],
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.effect(
  "steers a native subagent question to the child conversation while the parent continues",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* checkpointWorkspace("subagent_async_questions");
      const source = yield* CodexOrchestratorReplayHarness.decodeTranscript(
        materializeReplayTranscriptWorkspace(
          yield* decodeProviderReplayNdjson(
            yield* fs.readFileString(
              new URL("./fixtures/subagent_v2/codex_transcript.ndjson", import.meta.url).pathname,
            ),
          ),
          workspace,
        ),
      );
      const nativeThreadId = "native-v2-child-thread";
      const nativeTurnId = "native-v2-child-turn";
      const answerText = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        request_user_input_async: "child-async-question",
        answers: [{ question: "Which greeting?", answer: "Hello" }],
      });
      const entries = source.entries.flatMap((entry): ReadonlyArray<CodexAppServerReplayEntry> => {
        if (entry.type !== "emit_inbound" || entry.label !== "turn/started/child") return [entry];
        return [
          entry,
          {
            type: "emit_inbound",
            label: "child async question",
            frame: {
              method: "item/completed",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                item: {
                  type: "agentMessage",
                  id: "child-async-question",
                  text: "",
                  phase: "commentary",
                  delivery: "async",
                  questions: [{ title: "Which greeting?", options: ["Hello", "Hi"] }],
                },
              },
            },
          },
          {
            type: "expect_outbound",
            label: "child answer steering",
            frame: {
              id: 4,
              method: "turn/steer",
              params: {
                threadId: nativeThreadId,
                expectedTurnId: nativeTurnId,
                input: [{ type: "text", text: answerText }],
              },
            },
          },
          {
            type: "emit_inbound",
            label: "child answer accepted",
            frame: { id: 4, result: { turnId: nativeTurnId } },
          },
        ];
      });
      const materialized = yield* materializeFixtureInput({
        scenario: "subagent_async_questions",
        fixtureInput: {
          steps: [
            { type: "message", text: "just say hello" },
            { type: "answer_next_user_input_request", answers: { "question-1": "Hello" } },
          ],
        },
        driver: ProviderDriverKind.make("codex"),
        modelSelection: CODEX_MODEL_SELECTION,
      }).pipe(Effect.provide(idAllocatorLayer), provideDeterministicTestRuntime);
      const allocator = yield* IdAllocatorV2;
      const rootId = materialized.projectionThreadIds[0]!;
      const childId = allocator.derive.threadFromProviderThread({
        driver: ProviderDriverKind.make("codex"),
        nativeThreadId,
      });
      const result = yield* runOrchestratorV2ProviderReplayScenario(
        {
          name: "subagent_async_questions",
          transcript: { ...source, scenario: "subagent_async_questions", entries },
          commands: materialized.commands,
          steps: materialized.steps.flatMap<OrchestratorV2ScenarioStep>((step) =>
            step.type === "respond_to_next_runtime_request"
              ? [
                  {
                    type: "await_run_turn_item",
                    threadId: rootId,
                    runId: allocator.derive.run({ threadId: rootId, ordinal: 1 }),
                    itemType: "subagent",
                  },
                  { ...step, threadId: childId },
                ]
              : [step],
          ),
          projectionThreadIds: [...materialized.projectionThreadIds, childId],
          runtimePolicyOverride: { cwd: workspace },
        },
        CodexOrchestratorReplayHarness,
      ).pipe(provideDeterministicTestRuntime);
      const child = result.projections.get(childId)!;
      const root = result.projections.get(rootId)!;
      assert.equal(child.runs.length, 0);
      assert.equal(child.runtimeRequests.length, 1);
      assert.equal(child.runtimeRequests[0]?.status, "resolved");
      assert.deepEqual(child.runtimeRequests[0]?.responseCapability, {
        type: "message",
        providerThreadId: allocator.derive.providerThread({
          driver: ProviderDriverKind.make("codex"),
          nativeThreadId,
        }),
      });
      assert.equal(child.messages.filter((message) => message.text === answerText).length, 1);
      assert.equal(root.messages.filter((message) => message.text === answerText).length, 0);
    }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, NodeServices.layer))),
);
