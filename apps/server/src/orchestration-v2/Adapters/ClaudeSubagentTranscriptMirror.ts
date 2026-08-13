import { getSubagentMessages, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  OrchestrationV2ExecutionNode,
  OrchestrationV2TurnItem,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";

import type { IdAllocatorV2Shape } from "../IdAllocator.ts";
import type { ProviderAdapterV2Event } from "../ProviderAdapter.ts";
import { makeSubagentConversationArtifacts } from "../SubagentProjection.ts";

/**
 * Injectable transcript reader; production uses the Claude Agent SDK's
 * getSubagentMessages, tests substitute an in-memory fake.
 */
export type ClaudeSubagentTranscriptReader = (input: {
  readonly sessionId: string;
  readonly agentId: string;
  readonly dir?: string;
}) => Promise<ReadonlyArray<SessionMessage>>;

export const claudeSubagentTranscriptSdkReader: ClaudeSubagentTranscriptReader = (input) =>
  getSubagentMessages(
    input.sessionId,
    input.agentId,
    input.dir === undefined ? {} : { dir: input.dir },
  );

/**
 * Child-thread reasoning turn item shared by the live forwarded-frame path
 * and the transcript mirror. SubagentProjection stays untouched, so this
 * factory lives here (mirrors the shape of the subagent progress item).
 */
export function makeSubagentReasoningTurnItem(input: {
  readonly driver: ProviderDriverKind;
  readonly idAllocator: IdAllocatorV2Shape;
  readonly nativeItemId: string;
  readonly threadId: ThreadId;
  readonly rootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly text: string;
  readonly ordinal: number;
  readonly now: DateTime.Utc;
}): OrchestrationV2TurnItem {
  return {
    id: input.idAllocator.derive.turnItemFromProviderItem({
      driver: input.driver,
      nativeItemId: input.nativeItemId,
    }),
    threadId: input.threadId,
    runId: null,
    nodeId: input.rootNodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: {
      driver: input.driver,
      nativeId: input.nativeItemId,
      strength: "strong",
    },
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed",
    title: null,
    startedAt: input.now,
    completedAt: input.now,
    updatedAt: input.now,
    type: "reasoning",
    text: input.text,
    streaming: false,
  };
}

export interface ClaudeSubagentTranscriptMirrorTarget {
  readonly taskId: string;
  /** Native Claude session id of the parent query (transcript directory key). */
  readonly sessionId: string;
  readonly cwd?: string;
  readonly childThreadId: ThreadId;
  readonly childRootNodeId: OrchestrationV2ExecutionNode["id"];
  /**
   * Allocates the next child-thread ordinal from the live subagent registry
   * so mirrored items interleave correctly with stream-path items.
   */
  readonly nextChildItemOrdinal: Effect.Effect<number>;
}

export interface ClaudeSubagentTranscriptMirrorShape {
  readonly start: (target: ClaudeSubagentTranscriptMirrorTarget) => Effect.Effect<void>;
  readonly stop: (taskId: string) => Effect.Effect<void>;
}

interface MirrorPendingToolCall {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly ordinal: number;
  readonly startedAt: DateTime.Utc;
}

interface MirrorTaskState {
  readonly target: ClaudeSubagentTranscriptMirrorTarget;
  readonly seenUuids: Set<string>;
  // Ordinal memo keyed by native item id so a re-read (or the stream path
  // having already emitted the same item id) cannot renumber an item.
  readonly ordinals: Map<string, number>;
  readonly pendingToolCalls: Map<string, MirrorPendingToolCall>;
  promptSkipped: boolean;
  stopped: boolean;
  fiber: Fiber.Fiber<unknown, unknown> | null;
}

function transcriptContentBlocks(message: unknown): ReadonlyArray<Record<string, unknown>> {
  if (typeof message !== "object" || message === null) {
    return [];
  }
  const content = Reflect.get(message, "content");
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(
    (block): block is Record<string, unknown> => typeof block === "object" && block !== null,
  );
}

function joinedBlockText(
  blocks: ReadonlyArray<Record<string, unknown>>,
  type: "text" | "thinking",
): string {
  const field = type === "thinking" ? "thinking" : "text";
  return blocks
    .flatMap((block) =>
      block["type"] === type && typeof block[field] === "string" ? [block[field]] : [],
    )
    .join(type === "thinking" ? "\n\n" : "");
}

function toolResultOutputText(block: Record<string, unknown>): string {
  const content = block["content"];
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .flatMap((part) =>
        typeof part === "object" &&
        part !== null &&
        Reflect.get(part, "type") === "text" &&
        typeof Reflect.get(part, "text") === "string"
          ? [Reflect.get(part, "text") as string]
          : [],
      )
      .join("\n");
  }
  return "";
}

export const makeClaudeSubagentTranscriptMirror = Effect.fnUntraced(function* (options: {
  readonly driver: ProviderDriverKind;
  readonly idAllocator: IdAllocatorV2Shape;
  readonly emitEvent: (event: ProviderAdapterV2Event) => Effect.Effect<void>;
  readonly readSubagentMessages?: ClaudeSubagentTranscriptReader;
  readonly pollInterval?: Duration.Input;
}) {
  // Poll fibers are forked into the session scope captured here, so session
  // close interrupts every mirror without extra bookkeeping.
  const scope = yield* Effect.scope;
  const { driver, idAllocator, emitEvent } = options;
  const readSubagentMessages = options.readSubagentMessages ?? claudeSubagentTranscriptSdkReader;
  const pollInterval: Duration.Input = options.pollInterval ?? "2 seconds";
  const tasks = new Map<string, MirrorTaskState>();

  const ordinalFor = Effect.fnUntraced(function* (state: MirrorTaskState, nativeItemId: string) {
    const existing = state.ordinals.get(nativeItemId);
    if (existing !== undefined) {
      return existing;
    }
    const next = yield* state.target.nextChildItemOrdinal;
    state.ordinals.set(nativeItemId, next);
    return next;
  });

  const emitToolItem = Effect.fnUntraced(function* (input: {
    readonly state: MirrorTaskState;
    readonly nativeItemId: string;
    readonly toolName: string;
    readonly toolInput: unknown;
    readonly output?: string;
    readonly status: "running" | "completed" | "failed";
    readonly ordinal: number;
    readonly startedAt: DateTime.Utc;
    readonly now: DateTime.Utc;
  }) {
    const { target } = input.state;
    const completedAt = input.status === "running" ? null : input.now;
    const nativeItemRef = {
      driver,
      nativeId: input.nativeItemId,
      strength: "strong" as const,
    };
    yield* emitEvent({
      type: "node.updated",
      driver,
      node: {
        id: idAllocator.derive.nodeFromProviderItem({ driver, nativeItemId: input.nativeItemId }),
        threadId: target.childThreadId,
        runId: null,
        parentNodeId: target.childRootNodeId,
        rootNodeId: target.childRootNodeId,
        kind: "tool_call",
        status: input.status,
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: input.startedAt,
        completedAt,
      },
    });
    yield* emitEvent({
      type: "turn_item.updated",
      driver,
      turnItem: {
        id: idAllocator.derive.turnItemFromProviderItem({
          driver,
          nativeItemId: input.nativeItemId,
        }),
        threadId: target.childThreadId,
        runId: null,
        nodeId: idAllocator.derive.nodeFromProviderItem({
          driver,
          nativeItemId: input.nativeItemId,
        }),
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef,
        parentItemId: null,
        ordinal: input.ordinal,
        status: input.status,
        title: null,
        startedAt: input.startedAt,
        completedAt,
        updatedAt: input.now,
        type: "dynamic_tool",
        toolName: input.toolName,
        input: input.toolInput,
        ...(input.output === undefined || input.output.length === 0
          ? {}
          : { output: input.output }),
      },
    });
  });

  const emitAssistantArtifacts = Effect.fnUntraced(function* (input: {
    readonly state: MirrorTaskState;
    readonly nativeItemId: string;
    readonly text: string;
    readonly now: DateTime.Utc;
  }) {
    const { target } = input.state;
    const ordinal = yield* ordinalFor(input.state, input.nativeItemId);
    const artifacts = makeSubagentConversationArtifacts({
      messageId: idAllocator.derive.messageFromProviderItem({
        driver,
        nativeItemId: input.nativeItemId,
      }),
      turnItemId: idAllocator.derive.turnItemFromProviderItem({
        driver,
        nativeItemId: input.nativeItemId,
      }),
      threadId: target.childThreadId,
      rootNodeId: target.childRootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: { driver, nativeId: input.nativeItemId, strength: "strong" },
      role: "assistant",
      text: input.text,
      ordinal,
      now: input.now,
    });
    yield* emitEvent({ type: "message.updated", driver, message: artifacts.message });
    yield* emitEvent({ type: "turn_item.updated", driver, turnItem: artifacts.turnItem });
  });

  const mirrorAssistantMessage = Effect.fnUntraced(function* (
    state: MirrorTaskState,
    message: SessionMessage,
  ) {
    const blocks = transcriptContentBlocks(message.message);
    const now = yield* DateTime.now;
    const thinking = joinedBlockText(blocks, "thinking");
    if (thinking.length > 0) {
      const nativeItemId = `${message.uuid}:thinking`;
      yield* emitEvent({
        type: "turn_item.updated",
        driver,
        turnItem: makeSubagentReasoningTurnItem({
          driver,
          idAllocator,
          nativeItemId,
          threadId: state.target.childThreadId,
          rootNodeId: state.target.childRootNodeId,
          text: thinking,
          ordinal: yield* ordinalFor(state, nativeItemId),
          now,
        }),
      });
    }
    const text = joinedBlockText(blocks, "text");
    if (text.length > 0) {
      yield* emitAssistantArtifacts({ state, nativeItemId: message.uuid, text, now });
    }
    for (const block of blocks) {
      if (
        block["type"] !== "tool_use" ||
        typeof block["id"] !== "string" ||
        typeof block["name"] !== "string"
      ) {
        continue;
      }
      const ordinal = yield* ordinalFor(state, block["id"]);
      const pending: MirrorPendingToolCall = {
        toolName: block["name"],
        toolInput: block["input"],
        ordinal,
        startedAt: now,
      };
      state.pendingToolCalls.set(block["id"], pending);
      yield* emitToolItem({
        state,
        nativeItemId: block["id"],
        toolName: pending.toolName,
        toolInput: pending.toolInput,
        status: "running",
        ordinal,
        startedAt: now,
        now,
      });
    }
  });

  const mirrorUserMessage = Effect.fnUntraced(function* (
    state: MirrorTaskState,
    message: SessionMessage,
  ) {
    const blocks = transcriptContentBlocks(message.message);
    const toolResults = blocks.filter(
      (block) => block["type"] === "tool_result" && typeof block["tool_use_id"] === "string",
    );
    // The transcript's first plain user message is the kickoff prompt, which
    // the adapter already projected when the subagent row was created.
    if (toolResults.length === 0 && !state.promptSkipped) {
      state.promptSkipped = true;
      return;
    }
    const now = yield* DateTime.now;
    for (const block of toolResults) {
      const toolUseId = block["tool_use_id"] as string;
      const pending = state.pendingToolCalls.get(toolUseId);
      if (pending === undefined) {
        continue;
      }
      state.pendingToolCalls.delete(toolUseId);
      yield* emitToolItem({
        state,
        nativeItemId: toolUseId,
        toolName: pending.toolName,
        toolInput: pending.toolInput,
        output: toolResultOutputText(block),
        status: block["is_error"] === true ? "failed" : "completed",
        ordinal: pending.ordinal,
        startedAt: pending.startedAt,
        now,
      });
    }
  });

  const pollOnce = Effect.fnUntraced(function* (state: MirrorTaskState) {
    const read = yield* Effect.promise(async () => {
      try {
        return {
          messages: await readSubagentMessages({
            sessionId: state.target.sessionId,
            agentId: state.target.taskId,
            ...(state.target.cwd === undefined ? {} : { dir: state.target.cwd }),
          }),
        };
      } catch (cause) {
        return { cause };
      }
    });
    if (!("messages" in read)) {
      // An absent transcript (agent not started yet, foreground-only task) or
      // SDK read failure is routine; keep polling.
      yield* Effect.logDebug("orchestration-v2.claude-subagent-transcript-read-failed", {
        taskId: state.target.taskId,
        sessionId: state.target.sessionId,
        cause: read.cause,
      });
      return;
    }
    for (const message of read.messages) {
      if (state.seenUuids.has(message.uuid)) {
        continue;
      }
      state.seenUuids.add(message.uuid);
      if (message.type === "assistant") {
        yield* mirrorAssistantMessage(state, message);
      } else if (message.type === "user") {
        yield* mirrorUserMessage(state, message);
      }
    }
  });

  const forkPolling = (state: MirrorTaskState) =>
    Effect.forkIn(
      pollOnce(state).pipe(Effect.repeat(Schedule.spaced(pollInterval)), Effect.asVoid),
      scope,
    );

  const start: ClaudeSubagentTranscriptMirrorShape["start"] = Effect.fnUntraced(function* (
    target: ClaudeSubagentTranscriptMirrorTarget,
  ) {
    const existing = tasks.get(target.taskId);
    if (existing !== undefined) {
      // A resumed task (SendMessage re-emits task_started) restarts polling
      // with the accumulated dedupe state; an already-polling task is a no-op.
      if (existing.fiber === null) {
        existing.stopped = false;
        existing.fiber = yield* forkPolling(existing);
      }
      return;
    }
    const state: MirrorTaskState = {
      target,
      seenUuids: new Set(),
      ordinals: new Map(),
      pendingToolCalls: new Map(),
      promptSkipped: false,
      stopped: false,
      fiber: null,
    };
    tasks.set(target.taskId, state);
    state.fiber = yield* forkPolling(state);
  });

  const stop: ClaudeSubagentTranscriptMirrorShape["stop"] = Effect.fnUntraced(function* (
    taskId: string,
  ) {
    const state = tasks.get(taskId);
    if (state === undefined || state.stopped) {
      return;
    }
    state.stopped = true;
    if (state.fiber !== null) {
      yield* Fiber.interrupt(state.fiber);
      state.fiber = null;
    }
    // Final backfill before the caller emits the terminal result item, so
    // any transcript tail lands ahead of the result in child ordinals.
    yield* pollOnce(state);
    // A stopped task's transcript may omit trailing tool_results; close the
    // loop so the child thread does not show perpetually running tools.
    const now = yield* DateTime.now;
    for (const [toolUseId, pending] of state.pendingToolCalls) {
      yield* emitToolItem({
        state,
        nativeItemId: toolUseId,
        toolName: pending.toolName,
        toolInput: pending.toolInput,
        status: "completed",
        ordinal: pending.ordinal,
        startedAt: pending.startedAt,
        now,
      });
    }
    state.pendingToolCalls.clear();
  });

  return { start, stop } satisfies ClaudeSubagentTranscriptMirrorShape;
});
