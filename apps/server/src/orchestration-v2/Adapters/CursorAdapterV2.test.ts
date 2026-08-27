import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ModelSelection,
  ProviderInstanceId,
  ThreadId,
} from "@spiritdevs/contracts";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { subagentChildModelSelection } from "../SubagentProjection.ts";
import {
  CursorProviderCapabilitiesV2,
  cursorUserMessageIsEmpty,
  cursorMcpServers,
  cursorRuntimeAgentPolicy,
  cursorSdkModelSelection,
  makeCursorAgentOptions,
  nestedToolCallFromEnvelope,
} from "./CursorAdapterV2.ts";
import { isCursorCancellationError, loggedCursorAgentOptions } from "./CursorAgentSdk.ts";

describe("CursorAdapterV2", () => {
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
