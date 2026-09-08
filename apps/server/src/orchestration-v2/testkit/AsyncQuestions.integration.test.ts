import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChatAttachmentId, ProviderDriverKind } from "@spiritdevs/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { CodexAppServerReplayEntry } from "effect-codex-app-server/replay";
import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import { createDeterministicAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import {
  CODEX_MODEL_SELECTION,
  materializeFixtureInput,
  PLAN_QUESTIONS_PROMPT,
  READ_ONLY_NEVER_POLICY,
} from "./fixtures/shared.ts";
import {
  makeReplayServerConfig,
  runOrchestratorV2ProviderReplayScenario,
} from "./ProviderReplayHarness.ts";
import type { OrchestratorV2ScenarioStep } from "./OrchestratorScenario.ts";
import { checkpointWorkspace } from "./ReplayFixtureWorkspace.ts";
import {
  decodeProviderReplayNdjson,
  materializeReplayTranscriptWorkspace,
} from "./ReplayTranscriptNdjson.ts";

const encodeReply = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeString = Schema.encodeEffect(Schema.fromJsonString(Schema.String));
const decodeStartFrame = Schema.decodeUnknownEffect(
  Schema.Struct({ params: Schema.Record(Schema.String, Schema.Unknown) }),
);

for (const withImage of [false, true]) {
  for (const delivery of ["active", "idle", "steer-race"] as const) {
    const answerAfterCompletion = delivery === "idle";
    const steerRejected = delivery === "steer-race";
    it.effect(
      (withImage ? "with image: " : "") +
        (steerRejected
          ? "delivers a follow-up when Codex rejects steering after its turn ended"
          : answerAfterCompletion
            ? "starts a same-conversation follow-up for an answer after completion"
            : "atomically saves an async answer, steers it, and ignores replay after resolution"),
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const raw = yield* decodeProviderReplayNdjson(
            yield* fs.readFileString(
              new URL("./fixtures/plan_questions/codex_transcript.ndjson", import.meta.url)
                .pathname,
            ),
          );
          const workspace = yield* checkpointWorkspace("async_questions");
          const source = yield* CodexOrchestratorReplayHarness.decodeTranscript(
            materializeReplayTranscriptWorkspace(raw, workspace),
          );
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
          const serverConfig = yield* makeReplayServerConfig("async-answer-images");
          const imageBase64 =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9Z8AAAAASUVORK5CYII=";
          const image = {
            type: "image" as const,
            id: ChatAttachmentId.make(
              createDeterministicAttachmentId(
                materialized.projectionThreadIds[0]!,
                "answer-image",
              )!,
            ),
            name: "answer.png",
            mimeType: "image/png",
            sizeBytes: Buffer.from(imageBase64, "base64").length,
          };
          if (withImage)
            yield* fs.writeFile(
              resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment: image,
              })!,
              Buffer.from(imageBase64, "base64"),
            );
          const answerSteps = materialized.steps.map((step) =>
            step.type === "respond_to_next_runtime_request" && withImage
              ? {
                  ...step,
                  answers: { "question-1": "" },
                  attachmentsByQuestionId: { "question-1": [image] },
                }
              : step,
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
          const answerText = yield* encodeReply({
            request_user_input_async: "async-question",
            answers: [
              {
                question: "Which approach?",
                answer: withImage ? "" : "Strict schemas",
                ...(withImage ? { attachments: [image] } : {}),
              },
            ],
          });
          const answerInput = [
            { type: "text", text: answerText },
            ...(withImage ? [{ type: "image", url: `data:image/png;base64,${imageBase64}` }] : []),
          ];
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
                      input: answerInput,
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
            const startFrame = yield* decodeStartFrame(start.frame);
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
                  params: { ...startFrame.params, input: answerInput },
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
          const result = yield* runOrchestratorV2ProviderReplayScenario(
            {
              name: "async_questions",
              serverConfig,
              transcript: { ...source, scenario: "async_questions", entries },
              commands: materialized.commands,
              steps: answerAfterCompletion
                ? answerSteps.flatMap<OrchestratorV2ScenarioStep>((step) =>
                    step.type === "respond_to_next_runtime_request"
                      ? [{ type: "await_thread_idle" as const, threadId: step.threadId }, step]
                      : [step],
                  )
                : answerSteps,
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
          const answerMessages = projection.messages.filter(
            (message) => message.text === answerText,
          );
          assert.equal(answerMessages.length, 1);
          assert.deepEqual(answerMessages[0]?.attachments, withImage ? [image] : []);
          assert.deepEqual(
            projection.visibleTurnItems.find(
              (entry) =>
                entry.item.type === "user_message" &&
                entry.item.messageId === answerMessages[0]?.id,
            )?.item.type,
            "user_message",
          );
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
      const answerText = yield* encodeReply({
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

it.effect(
  "delivers a photo-only blocking Codex answer as a file reference and saves answer history",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* checkpointWorkspace("blocking_answer_images");
      const source = yield* CodexOrchestratorReplayHarness.decodeTranscript(
        materializeReplayTranscriptWorkspace(
          yield* decodeProviderReplayNdjson(
            yield* fs.readFileString(
              new URL("./fixtures/plan_questions/codex_transcript.ndjson", import.meta.url)
                .pathname,
            ),
          ),
          workspace,
        ),
      );
      const materialized = yield* materializeFixtureInput({
        scenario: "blocking_answer_images",
        fixtureInput: {
          interactionMode: "plan",
          steps: [
            { type: "message", text: PLAN_QUESTIONS_PROMPT },
            { type: "answer_next_user_input_request", answers: { schema_vs_ui_flexibility: "" } },
          ],
        },
        driver: ProviderDriverKind.make("codex"),
        modelSelection: CODEX_MODEL_SELECTION,
      }).pipe(Effect.provide(idAllocatorLayer), provideDeterministicTestRuntime);
      const serverConfig = yield* makeReplayServerConfig("blocking_answer_images");
      const image = {
        type: "image" as const,
        id: ChatAttachmentId.make(
          createDeterministicAttachmentId(materialized.projectionThreadIds[0]!, "answer-image")!,
        ),
        name: "answer.png",
        mimeType: "image/png",
        sizeBytes: 3,
      };
      const imagePath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment: image,
      })!;
      yield* fs.writeFileString(imagePath, "png");
      const quotedPath = yield* encodeString(imagePath);
      const entries = source.entries.map((entry) =>
        entry.type === "expect_outbound" && entry.label === "item/tool/requestUserInput"
          ? {
              ...entry,
              frame: {
                id: 0,
                result: {
                  answers: {
                    schema_vs_ui_flexibility: {
                      answers: [
                        `Attached image "answer.png": ${quotedPath}. Open this file to see the user's answer.`,
                      ],
                    },
                  },
                },
              },
            }
          : entry,
      );
      const result = yield* runOrchestratorV2ProviderReplayScenario(
        {
          name: "blocking_answer_images",
          serverConfig,
          transcript: { ...source, scenario: "blocking_answer_images", entries },
          commands: materialized.commands,
          steps: materialized.steps.map((step) =>
            step.type === "respond_to_next_runtime_request"
              ? { ...step, attachmentsByQuestionId: { schema_vs_ui_flexibility: [image] } }
              : step,
          ),
          projectionThreadIds: materialized.projectionThreadIds,
          runtimePolicyOverride: { ...READ_ONLY_NEVER_POLICY, cwd: workspace },
        },
        CodexOrchestratorReplayHarness,
      ).pipe(provideDeterministicTestRuntime);
      const projection = result.projections.get(materialized.projectionThreadIds[0]!)!;
      const reply = projection.messages.find((message) =>
        message.id.startsWith("message:question-answer:"),
      );
      assert.deepEqual(reply?.attachments, [image]);
      assert.equal(projection.runs.length, 1);
      assert.equal(projection.runtimeRequests[0]?.status, "resolved");
      assert.notInclude(reply?.text ?? "", imagePath);
      assert.include(reply?.text ?? "", "answer.png");
    }).pipe(Effect.provide(NodeServices.layer)),
);
