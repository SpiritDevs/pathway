import { projectCursorDynamicToolCall } from "./CursorAdapterV2.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CursorSettings,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { layerTest as serverConfigLayerTest, ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { layer as idAllocatorLayer, IdAllocatorV2 } from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import { subagentChildModelSelection } from "../SubagentProjection.ts";
import {
  CursorProviderCapabilitiesV2,
  cursorUserMessageIsEmpty,
  cursorMcpServers,
  cursorRuntimeAgentPolicy,
  cursorSdkModelSelection,
  makeCursorAdapterV2,
  makeCursorAgentOptions,
  nestedToolCallFromEnvelope,
} from "./CursorAdapterV2.ts";
import { isCursorCancellationError, loggedCursorAgentOptions } from "./CursorAgentSdk.ts";

const decodeCursorSettings = Schema.decodeEffect(CursorSettings);

describe("CursorAdapterV2", () => {
  // Cursor may name a task's model only on a later update of the same call.
  it.effect.each([
    { name: "late report", model: undefined, lateModel: "gpt-6-sol", expected: "gpt-6-sol" },
    { name: "omitted later", model: "gpt-6-sol", lateModel: undefined, expected: "gpt-6-sol" },
    { name: "blank later", model: "gpt-6-sol", lateModel: " \t ", expected: "gpt-6-sol" },
    { name: "never reported", model: undefined, lateModel: undefined, expected: "composer-2.5" },
  ] as const)("projects a Cursor task model: $name", ({ model, lateModel, expected }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "cursor-v2-task-model-",
      });
      const instanceId = ProviderInstanceId.make("cursor");
      const threadId = ThreadId.make("cursor-task-model-thread");
      const modelSelection = {
        instanceId,
        model: "composer-2.5",
        options: [{ id: "fastMode", value: true }],
      } satisfies ModelSelection;
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const adapter = makeCursorAdapterV2({
        instanceId,
        settings: yield* decodeCursorSettings({}),
        environment: { HOME: workspace },
        fileSystem,
        idAllocator: yield* IdAllocatorV2,
        serverConfig: yield* ServerConfig.pipe(
          Effect.provide(serverConfigLayerTest(workspace, { prefix: "cursor-v2-task-model-" })),
        ),
        runner: {
          assertComplete: Effect.void,
          open: () =>
            Effect.succeed({
              agentId: "native-cursor-task-model",
              listMessages: Effect.succeed([]),
              close: Effect.void,
              send: (input) =>
                Effect.gen(function* () {
                  const args = {
                    description: "Review",
                    prompt: "Review the code.",
                    subagentType: { kind: "unspecified" as const },
                    agentId: "cursor-task-agent",
                    mode: "unspecified" as const,
                  };
                  for (const [type, reported] of [
                    ["tool-call-started", model],
                    ["tool-call-completed", lateModel],
                  ] as const) {
                    yield* input.onDelta!({
                      type,
                      modelCallId: "model-call",
                      callId: "task-call",
                      toolCall: {
                        type: "task",
                        args: { ...args, ...(reported === undefined ? {} : { model: reported }) },
                      },
                    }).pipe(Effect.orDie);
                  }
                  return {
                    agentId: "native-cursor-task-model",
                    runId: "native-cursor-run",
                    wait: Effect.succeed({
                      id: "native-cursor-run",
                      requestId: "native-request",
                      status: "finished" as const,
                      model: { id: "composer-2.5" },
                      durationMs: 1,
                    }),
                    cancel: Effect.void,
                  };
                }),
            }),
        },
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-task-model-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn({
        threadId,
        providerThread,
        modelSelection,
        runtimePolicy,
        runId: RunId.make("cursor-task-model-run"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("cursor-task-model-attempt"),
        rootNodeId: NodeId.make("cursor-task-model-root"),
        appThread: {
          id: threadId,
          projectId: ProjectId.make("cursor-task-model-project"),
          createdBy: "user",
          creationSource: "web",
          title: "Cursor task model",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        message: {
          messageId: MessageId.make("cursor-task-model-message"),
          createdBy: "user",
          creationSource: "web",
          text: "Review the code.",
          attachments: [],
        },
      });
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      const rows = events.filter((event) => event.type === "subagent.updated");
      const childThreadId = rows[0]?.subagent.childThreadId;
      const childSelections = events.flatMap((event) =>
        event.type === "app_thread.created" && event.appThread.id === childThreadId
          ? [event.appThread.modelSelection]
          : event.type === "app_thread.model_reported" && event.threadId === childThreadId
            ? [event.modelSelection]
            : [],
      );
      const expectedSelection = subagentChildModelSelection({
        parentSelection: modelSelection,
        reportedModel: expected,
      });
      assert.equal(rows[0]?.subagent.model, model ?? "composer-2.5");
      assert.equal(rows.at(-1)?.subagent.status, "completed");
      assert.equal(rows.at(-1)?.subagent.model, expected);
      assert.deepEqual(rows.at(-1)?.subagent.options, expectedSelection.options);
      assert.deepEqual(childSelections.at(-1), expectedSelection);
      assert.lengthOf(childSelections, model === undefined && lateModel !== undefined ? 2 : 1);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, idAllocatorLayer))),
  );

  it("keeps the project primary while granting the retained conversation folder to Cursor", () => {
    const options = makeCursorAgentOptions({
      threadId: ThreadId.make("conversation"),
      modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "auto" },
      runtimePolicy: {
        runtimeMode: "auto-accept-edits",
        interactionMode: "default",
        cwd: "/workspace/project",
        additionalDirectories: ["/userdata/conversations/one", "/workspace/project"],
      },
    });
    assert.deepEqual(options.local?.cwd, ["/workspace/project", "/userdata/conversations/one"]);
    assert.deepEqual(options.local?.sandboxOptions, { enabled: true });
  });
  it("accepts a resolved file-path prompt without native images", () => {
    assert.isFalse(
      cursorUserMessageIsEmpty({
        resolvedText: "[Attached file is saved at /tmp/report.pdf]",
        imageCount: 0,
      }),
    );
    assert.isTrue(cursorUserMessageIsEmpty({ resolvedText: "", imageCount: 0 }));
  });

  it("maps Cursor auto and model parameters to SDK selections", () => {
    assert.deepEqual(
      cursorSdkModelSelection({
        instanceId: ProviderInstanceId.make("cursor"),
        model: "auto",
        options: [
          { id: "thinking", value: "high" },
          { id: "contextWindow", value: "1m" },
          { id: "fastMode", value: true },
        ],
      }),
      {
        id: "default",
        params: [
          { id: "thinking", value: "high" },
          { id: "context", value: "1m" },
          { id: "fast", value: "true" },
        ],
      },
    );
  });

  it("maps runtime modes to the SDK sandbox and auto-review controls", () => {
    const base = {
      interactionMode: "default" as const,
      cwd: "/tmp/cursor-adapter",
    };
    assert.deepEqual(
      cursorRuntimeAgentPolicy({
        ...base,
        runtimeMode: "full-access",
      }),
      {
        autoReview: false,
        sandboxEnabled: false,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy({
        ...base,
        runtimeMode: "auto-accept-edits",
      }),
      {
        autoReview: false,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy({
        ...base,
        runtimeMode: "approval-required",
      }),
      {
        autoReview: true,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy({
        ...base,
        runtimeMode: "full-access",
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
      }),
      {
        autoReview: false,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy({
        ...base,
        runtimeMode: "approval-required",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      }),
      {
        autoReview: false,
        sandboxEnabled: false,
      },
    );
  });

  it("advertises only capabilities exposed by the official SDK adapter", () => {
    assert.isTrue(CursorProviderCapabilitiesV2.threads.canReadThreadSnapshot);
    assert.isFalse(CursorProviderCapabilitiesV2.threads.canForkThread);
    assert.isFalse(CursorProviderCapabilitiesV2.threads.canRollbackThread);
    assert.isTrue(CursorProviderCapabilitiesV2.turns.supportsInterrupt);
    assert.isFalse(CursorProviderCapabilitiesV2.turns.supportsActiveSteering);
    assert.isTrue(CursorProviderCapabilitiesV2.turns.supportsSteeringByInterruptRestart);
    assert.isTrue(CursorProviderCapabilitiesV2.tools.supportsMcpTools);
    assert.isTrue(CursorProviderCapabilitiesV2.subagents.supportsSubagents);
    assert.isFalse(CursorProviderCapabilitiesV2.subagents.exposesSubagentThreadIds);
    assert.equal(CursorProviderCapabilitiesV2.identity.nativeItemIds, "weak");
    assert.isFalse(CursorProviderCapabilitiesV2.approvals.supportsCommandApproval);
  });

  it("injects thread-scoped MCP credentials without logging them", () => {
    const threadId = ThreadId.make("thread-cursor-mcp");
    McpProviderSession.setMcpProviderSession({
      environmentId: EnvironmentId.make("environment-cursor-mcp"),
      threadId,
      providerSessionId: "mcp-session-cursor",
      providerInstanceId: ProviderInstanceId.make("cursor"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-cursor-mcp-token",
    });

    try {
      assert.deepEqual(cursorMcpServers(threadId), {
        pathway: {
          type: "http",
          url: "http://127.0.0.1:43123/mcp",
          headers: {
            Authorization: "Bearer secret-cursor-mcp-token",
          },
        },
      });

      const options = makeCursorAgentOptions({
        apiKey: "secret-cursor-api-key",
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "composer-2.5",
        },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace",
        },
        threadId,
      });
      assert.deepEqual(options.mcpServers, cursorMcpServers(threadId));

      const logged = JSON.stringify(loggedCursorAgentOptions(options));
      assert.notInclude(logged, "secret-cursor-api-key");
      assert.notInclude(logged, "secret-cursor-mcp-token");
    } finally {
      McpProviderSession.clearMcpProviderSession(threadId);
    }
  });

  it("recognizes direct and SDK-wrapped abort failures as cancellation", () => {
    assert.isTrue(isCursorCancellationError({ name: "AbortError" }));
    assert.isTrue(
      isCursorCancellationError({
        name: "ConnectError",
        cause: {
          name: "ConnectError",
          cause: { name: "AbortError" },
        },
      }),
    );
    assert.isFalse(isCursorCancellationError(new Error("request failed")));
    assert.isFalse(isCursorCancellationError(null));
  });

  it("preserves failed nested read calls when Cursor omits their path", () => {
    assert.deepEqual(
      nestedToolCallFromEnvelope({
        toolCallId: "tool:failed-read",
        readToolCall: {
          args: {},
          result: { error: "File path was not provided." },
        },
      }),
      {
        callId: "tool:failed-read",
        toolCall: {
          type: "read",
          args: { path: "<unknown path>" },
          result: {
            status: "error",
            error: "File path was not provided.",
          },
        },
      },
    );
  });

  // The task tool reports the subagent's model but never its options, so the
  // parent's selections only carry over on the parent's own model. Both the
  // subagent record and its child thread read this one selection.
  it("keeps the parent's option selections only for a same-model task", () => {
    const parentSelection = {
      instanceId: ProviderInstanceId.make("cursor"),
      model: "composer-2.5",
      options: [
        { id: "thinking", value: "high" },
        { id: "fastMode", value: true },
      ],
    } satisfies ModelSelection;

    assert.deepEqual(
      subagentChildModelSelection({ parentSelection, reportedModel: "composer-2.5" }),
      parentSelection,
    );
    assert.deepEqual(
      subagentChildModelSelection({ parentSelection, reportedModel: "claude-4.5-sonnet" }),
      { instanceId: parentSelection.instanceId, model: "claude-4.5-sonnet" },
    );
    // `args.model` is absent whenever the task stayed on the parent's model.
    assert.deepEqual(
      subagentChildModelSelection({ parentSelection, reportedModel: undefined }),
      parentSelection,
    );
  });
});

describe("Cursor HTML MCP projection", () => {
  const htmlResult = {
    htmlRender: { attachmentId: "thread-html-attachment", title: "Chart", height: 400 },
    message: "Shown",
  };
  const rawHtml = "<html><body>Chart</body></html>";

  it("normalizes only Pathway identity and compacts nested MCP text envelopes", () => {
    for (const providerIdentifier of ["pathway", "other"]) {
      const output = { isError: false, content: [{ text: { text: JSON.stringify(htmlResult) } }] };
      const item = projectCursorDynamicToolCall({
        type: "mcp",
        args: {
          providerIdentifier,
          toolName: "html_render",
          args: { html: rawHtml, title: "Chart", height: 400 },
        },
        result: { status: "success", value: output },
      });
      assert.equal(
        item.toolName,
        providerIdentifier === "pathway" ? "pathway.html_render" : "mcp__other__html_render",
      );
      assert.deepEqual(item.output, providerIdentifier === "pathway" ? htmlResult : output);
    }
  });
  it("preserves native MCP isError and strips PNG data", () => {
    const item = projectCursorDynamicToolCall({
      type: "mcp",
      args: {
        providerIdentifier: "pathway",
        toolName: "html_preview",
        args: { html: rawHtml, width: 390 },
      },
      result: {
        status: "success",
        value: {
          isError: true,
          content: [
            { text: { text: "Failed" } },
            { image: { data: "secret-base64", mimeType: "image/png" } },
          ],
        },
      },
    });
    assert.deepEqual(item.output, { isError: true, message: "Failed" });
    assert.notInclude(JSON.stringify(item), "secret-base64");
    assert.notInclude(JSON.stringify(item), rawHtml);
  });
});
