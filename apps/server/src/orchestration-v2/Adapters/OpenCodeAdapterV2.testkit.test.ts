import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ProviderAdapterRegistryV2 } from "../ProviderAdapterRegistry.ts";
import { ProviderAdapterV2RuntimePolicy, type ProviderAdapterV2Event } from "../ProviderAdapter.ts";
import { OPENCODE_DEFAULT_INSTANCE_ID, OPENCODE_PROVIDER } from "./OpenCodeAdapterV2.ts";
import {
  OPENCODE_SDK_REPLAY_PROTOCOL,
  OpenCodeReplayController,
  makeOpenCodeProviderAdapterRegistryReplayLayer,
} from "./OpenCodeAdapterV2.testkit.ts";

describe("OpenCodeAdapterV2 replay testkit", () => {
  it.effect("stops an event stream when abort races with listener registration", () =>
    Effect.gen(function* () {
      let aborted = false;
      const signal = {
        get aborted() {
          return aborted;
        },
        addEventListener: () => {
          aborted = true;
        },
        removeEventListener: () => {},
      } as unknown as AbortSignal;
      const controller = new OpenCodeReplayController({
        provider: OPENCODE_PROVIDER,
        protocol: OPENCODE_SDK_REPLAY_PROTOCOL,
        version: "test",
        scenario: "abort-during-listener-registration",
        entries: [],
      });
      const iterator = controller.events(signal)[Symbol.asyncIterator]();

      const result = yield* Effect.promise(() => iterator.next()).pipe(
        Effect.timeout("100 millis"),
      );

      assert.isTrue(result.done);
    }),
  );

  it.effect("rejects a cancelled question without replying with empty answers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-opencode-cancel-question");
        const modelSelection = {
          instanceId: OPENCODE_DEFAULT_INSTANCE_ID,
          model: "openai/test-model",
        } as const;
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: "/workspace",
        });
        const registry = yield* ProviderAdapterRegistryV2;
        const adapter = yield* registry.get(OPENCODE_DEFAULT_INSTANCE_ID);
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-opencode-cancel-question"),
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project-opencode-cancel-question"),
            title: "OpenCode cancellation",
            providerInstanceId: OPENCODE_DEFAULT_INSTANCE_ID,
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: threadId,
            },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId: RunId.make("run-opencode-cancel-question"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("attempt-opencode-cancel-question"),
          rootNodeId: NodeId.make("node-opencode-cancel-question"),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-opencode-cancel-question"),
            text: "Ask a question.",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        });
        let requestId;
        while (requestId === undefined) {
          const event = yield* Queue.take(events);
          if (
            event.type === "runtime_request.updated" &&
            event.runtimeRequest.status === "pending"
          ) {
            requestId = event.runtimeRequest.id;
          }
        }
        yield* runtime.respondToRuntimeRequest({ requestId, decision: "cancel" });
      }).pipe(
        Effect.provide(
          makeOpenCodeProviderAdapterRegistryReplayLayer({
            provider: OPENCODE_PROVIDER,
            protocol: OPENCODE_SDK_REPLAY_PROTOCOL,
            version: "test",
            scenario: "cancel-question",
            entries: [
              { type: "expect_outbound", frame: { type: "event.subscribe" } },
              {
                type: "expect_outbound",
                frame: { type: "session.create", input: "<any>" },
              },
              {
                type: "emit_inbound",
                frame: {
                  type: "sdk.response",
                  operation: "session.create",
                  data: { id: "native-opencode-cancel", time: { created: 1, updated: 1 } },
                },
              },
              {
                type: "expect_outbound",
                frame: { type: "session.promptAsync", input: "<any>" },
              },
              {
                type: "emit_inbound",
                frame: { type: "sdk.response", operation: "session.promptAsync", data: null },
              },
              {
                type: "emit_inbound",
                frame: {
                  type: "sdk.event",
                  event: {
                    type: "question.asked",
                    properties: {
                      id: "native-question-cancel",
                      sessionID: "native-opencode-cancel",
                      questions: [
                        {
                          question: "Proceed?",
                          header: "Choice",
                          options: [],
                          multiple: false,
                        },
                      ],
                    },
                  },
                },
              },
              {
                type: "expect_outbound",
                frame: {
                  type: "question.reject",
                  input: { requestID: "native-question-cancel" },
                },
              },
              {
                type: "emit_inbound",
                frame: { type: "sdk.response", operation: "question.reject", data: true },
              },
              { type: "runtime_exit", status: "success" },
            ],
          }),
        ),
      ),
    ),
  );

  it.effect("resumes a task child after the parent turn that launched it completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-opencode-task-resume");
        const modelSelection = {
          instanceId: OPENCODE_DEFAULT_INSTANCE_ID,
          model: "openai/test-model",
        } as const;
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: "/workspace",
        });
        const registry = yield* ProviderAdapterRegistryV2;
        const adapter = yield* registry.get(OPENCODE_DEFAULT_INSTANCE_ID);
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-opencode-task-resume"),
          modelSelection,
          runtimePolicy,
        });
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        yield* runtime.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project-opencode-task-resume"),
            title: "OpenCode task resume",
            providerInstanceId: OPENCODE_DEFAULT_INSTANCE_ID,
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: threadId,
            },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId: RunId.make("run-opencode-task-resume"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("attempt-opencode-task-resume"),
          rootNodeId: NodeId.make("node-opencode-task-resume"),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-opencode-task-resume"),
            text: "Delegate a task.",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        });
        let childProviderThreadId;
        let parentCompleted = false;
        while (true) {
          const event = yield* Queue.take(events);
          if (event.type === "app_thread.created") {
            childProviderThreadId = event.appThread.activeProviderThreadId;
          }
          if (event.type === "turn.terminal" && event.providerThreadId === providerThread.id) {
            assert.strictEqual(event.status, "completed");
            parentCompleted = true;
          }
          if (
            event.type === "provider_turn.updated" &&
            event.providerTurn.providerThreadId === childProviderThreadId &&
            event.providerTurn.status === "running"
          ) {
            break;
          }
        }
        assert.isDefined(childProviderThreadId);
        assert.isTrue(parentCompleted);
      }).pipe(
        Effect.provide(
          makeOpenCodeProviderAdapterRegistryReplayLayer({
            provider: OPENCODE_PROVIDER,
            protocol: OPENCODE_SDK_REPLAY_PROTOCOL,
            version: "test",
            scenario: "task-resume",
            entries: [
              { type: "expect_outbound", frame: { type: "event.subscribe" } },
              {
                type: "expect_outbound",
                frame: { type: "session.create", input: "<any>" },
              },
              {
                type: "emit_inbound",
                frame: {
                  type: "sdk.response",
                  operation: "session.create",
                  data: { id: "native-opencode-parent", time: { created: 1, updated: 1 } },
                },
              },
              {
                type: "expect_outbound",
                frame: { type: "session.promptAsync", input: "<any>" },
              },
              {
                type: "emit_inbound",
                frame: { type: "sdk.response", operation: "session.promptAsync", data: null },
              },
              {
                type: "emit_inbound",
                frame: {
                  type: "sdk.event",
                  event: {
                    type: "message.part.updated",
                    properties: {
                      part: {
                        id: "native-task-part",
                        sessionID: "native-opencode-parent",
                        messageID: "native-parent-assistant",
                        type: "tool",
                        callID: "native-task-call",
                        tool: "task",
                        state: {
                          status: "completed",
                          input: { prompt: "Look around.", description: "Explore" },
                          output: "x".repeat(64 * 1024),
                          title: "Explore",
                          metadata: { sessionId: "native-opencode-child" },
                          time: { start: 2, end: 3 },
                        },
                      },
                    },
                  },
                },
              },
              {
                type: "expect_outbound",
                frame: { type: "session.get", input: { sessionID: "native-opencode-child" } },
              },
              {
                type: "emit_inbound",
                frame: {
                  type: "sdk.response",
                  operation: "session.get",
                  data: { id: "native-opencode-child", permission: [] },
                },
              },
              {
                type: "expect_outbound",
                frame: { type: "session.update", input: "<any>" },
              },
              {
                type: "emit_inbound",
                frame: { type: "sdk.response", operation: "session.update", data: null },
              },
              {
                type: "emit_inbound",
                frame: {
                  type: "sdk.event",
                  event: {
                    type: "session.idle",
                    properties: { sessionID: "native-opencode-parent" },
                  },
                },
              },
              {
                type: "emit_inbound",
                frame: {
                  type: "sdk.event",
                  event: {
                    type: "message.updated",
                    properties: {
                      sessionID: "native-opencode-child",
                      info: {
                        id: "native-child-user",
                        sessionID: "native-opencode-child",
                        role: "user",
                        time: { created: 4 },
                      },
                    },
                  },
                },
              },
              { type: "runtime_exit", status: "success" },
            ],
          }),
        ),
      ),
    ),
  );
});
