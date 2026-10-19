import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { NodeId, ThreadId } from "@spiritdevs/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import type { ProviderAdapterV2Event } from "../ProviderAdapter.ts";
import { layer as idAllocatorLayer, IdAllocatorV2 } from "../IdAllocator.ts";
import { CLAUDE_PROVIDER } from "./ClaudeAdapterV2.ts";
import { makeClaudeSubagentTranscriptMirror } from "./ClaudeSubagentTranscriptMirror.ts";

describe("ClaudeSubagentTranscriptMirror", () => {
  const SESSION_ID = "native-session-mirror";
  const TASK_ID = "task-mirror";
  const CHILD_THREAD_ID = ThreadId.make("thread-child-mirror");
  const CHILD_ROOT_NODE_ID = NodeId.make("node-child-root-mirror");

  const promptMessage: SessionMessage = {
    type: "user",
    uuid: "uuid-prompt",
    session_id: SESSION_ID,
    message: { role: "user", content: "Do the background work." },
    parent_tool_use_id: null,
    parent_agent_id: null,
  };
  const makeAssistantMessage = (input: {
    readonly uuid: string;
    readonly text?: string;
    readonly thinking?: string;
    readonly toolUse?: { readonly id: string; readonly name: string; readonly input: unknown };
  }): SessionMessage => ({
    type: "assistant",
    uuid: input.uuid,
    session_id: SESSION_ID,
    message: {
      role: "assistant",
      content: [
        ...(input.thinking === undefined
          ? []
          : [{ type: "thinking", thinking: input.thinking, signature: "sig" }]),
        ...(input.text === undefined ? [] : [{ type: "text", text: input.text }]),
        ...(input.toolUse === undefined ? [] : [{ type: "tool_use", ...input.toolUse }]),
      ],
    },
    parent_tool_use_id: null,
    parent_agent_id: null,
  });
  const makeToolResultMessage = (input: {
    readonly uuid: string;
    readonly toolUseId: string;
    readonly output: string;
    readonly isError?: boolean;
  }): SessionMessage => ({
    type: "user",
    uuid: input.uuid,
    session_id: SESSION_ID,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: input.toolUseId,
          content: [{ type: "text", text: input.output }],
          ...(input.isError === true ? { is_error: true } : {}),
        },
      ],
    },
    parent_tool_use_id: null,
    parent_agent_id: null,
  });

  // TestClock gates only the mirror's Schedule timers; yielding lets the
  // poll fibers and their reader promises settle between checks.
  const awaitUntil = (predicate: () => boolean, label: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 5000; attempt++) {
        if (predicate()) {
          return;
        }
        yield* Effect.yieldNow;
      }
      return yield* Effect.die(`Timed out waiting for ${label}.`);
    });

  const makeMirrorHarness = Effect.gen(function* () {
    const idAllocator = yield* IdAllocatorV2;
    const events: Array<ProviderAdapterV2Event> = [];
    const readerCalls: Array<{
      readonly sessionId: string;
      readonly agentId: string;
      readonly dir?: string;
    }> = [];
    let transcript: ReadonlyArray<SessionMessage> = [];
    let failReads = false;
    const mirror = yield* makeClaudeSubagentTranscriptMirror({
      driver: CLAUDE_PROVIDER,
      idAllocator,
      emitEvent: (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      readSubagentMessages: (input) => {
        readerCalls.push(input);
        return failReads
          ? Promise.reject(new Error("transcript not found"))
          : Promise.resolve([...transcript]);
      },
    });
    let nextOrdinal = 100;
    const target = {
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      cwd: "/workspace",
      childThreadId: CHILD_THREAD_ID,
      childRootNodeId: CHILD_ROOT_NODE_ID,
      nextChildItemOrdinal: Effect.sync(() => ++nextOrdinal),
    };
    return {
      mirror,
      target,
      events,
      readerCalls,
      setTranscript: (messages: ReadonlyArray<SessionMessage>) => {
        transcript = messages;
      },
      setFailReads: (value: boolean) => {
        failReads = value;
      },
      messageEvents: () =>
        events.filter(
          (event): event is Extract<ProviderAdapterV2Event, { type: "message.updated" }> =>
            event.type === "message.updated",
        ),
      itemEvents: () =>
        events.filter(
          (event): event is Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }> =>
            event.type === "turn_item.updated",
        ),
    };
  });

  it.effect("mirrors transcript increments and skips the kickoff prompt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeMirrorHarness;
        harness.setTranscript([
          promptMessage,
          makeAssistantMessage({
            uuid: "uuid-a1",
            thinking: "Considering the approach.",
            text: "Starting the work.",
          }),
        ]);
        yield* harness.mirror.start(harness.target);
        yield* awaitUntil(
          () =>
            harness.messageEvents().some((event) => event.message.text === "Starting the work."),
          "first mirrored assistant message",
        );

        const reasoning = harness
          .itemEvents()
          .find((event) => event.turnItem.type === "reasoning")?.turnItem;
        assert.isDefined(reasoning);
        assert.equal(reasoning?.threadId, CHILD_THREAD_ID);
        assert.equal(reasoning?.runId, null);
        assert.equal(reasoning?.ordinal, 101);
        assert.equal(
          reasoning?.type === "reasoning" && reasoning.text,
          "Considering the approach.",
        );
        const message = harness.messageEvents()[0]?.message;
        assert.equal(message?.threadId, CHILD_THREAD_ID);
        assert.equal(message?.runId, null);
        assert.equal(message?.role, "assistant");
        const assistantItem = harness
          .itemEvents()
          .find((event) => event.turnItem.type === "assistant_message")?.turnItem;
        assert.equal(assistantItem?.ordinal, 102);
        // The kickoff prompt is already projected by the adapter.
        assert.isFalse(harness.messageEvents().some((event) => event.message.role === "user"));

        // Incremental growth: a tool call and its result arrive on a later poll.
        harness.setTranscript([
          promptMessage,
          makeAssistantMessage({
            uuid: "uuid-a1",
            thinking: "Considering the approach.",
            text: "Starting the work.",
          }),
          makeAssistantMessage({
            uuid: "uuid-a2",
            toolUse: { id: "toolu-mirror-1", name: "Bash", input: { command: "ls" } },
          }),
          makeToolResultMessage({
            uuid: "uuid-u2",
            toolUseId: "toolu-mirror-1",
            output: "file.txt",
          }),
        ]);
        yield* TestClock.adjust("2 seconds");
        yield* awaitUntil(
          () =>
            harness
              .itemEvents()
              .some(
                (event) =>
                  event.turnItem.type === "dynamic_tool" && event.turnItem.status === "completed",
              ),
          "mirrored tool completion",
        );
        const toolItems = harness
          .itemEvents()
          .filter(
            (event) =>
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.nativeItemRef?.nativeId === "toolu-mirror-1",
          )
          .map((event) => event.turnItem);
        assert.equal(toolItems[0]?.status, "running");
        const completed = toolItems.at(-1);
        assert.equal(completed?.status, "completed");
        assert.equal(completed?.type === "dynamic_tool" && completed.toolName, "Bash");
        assert.equal(completed?.type === "dynamic_tool" && completed.output, "file.txt");
        // Completion reuses the running item's ordinal.
        assert.equal(completed?.ordinal, toolItems[0]?.ordinal);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, TestClock.layer()))),
    ),
  );

  it.effect("re-polling an unchanged transcript is idempotent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeMirrorHarness;
        harness.setTranscript([
          promptMessage,
          makeAssistantMessage({ uuid: "uuid-a1", text: "Only answer." }),
        ]);
        yield* harness.mirror.start(harness.target);
        yield* awaitUntil(() => harness.messageEvents().length === 1, "mirrored message");
        const emittedCount = harness.events.length;
        const readsBefore = harness.readerCalls.length;
        yield* TestClock.adjust("2 seconds");
        yield* TestClock.adjust("2 seconds");
        yield* awaitUntil(
          () => harness.readerCalls.length >= readsBefore + 2,
          "two additional polls",
        );
        assert.equal(harness.events.length, emittedCount);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, TestClock.layer()))),
    ),
  );

  it.effect("stop performs a final backfill read, closes pending tools, and halts polling", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeMirrorHarness;
        harness.setTranscript([promptMessage]);
        yield* harness.mirror.start(harness.target);
        yield* awaitUntil(() => harness.readerCalls.length >= 1, "initial poll");

        // The terminal notification races the last transcript flush; stop's
        // final read must pick up the tail.
        harness.setTranscript([
          promptMessage,
          makeAssistantMessage({ uuid: "uuid-a1", text: "Late final answer." }),
          makeAssistantMessage({
            uuid: "uuid-a2",
            toolUse: { id: "toolu-open", name: "Bash", input: { command: "sleep 1" } },
          }),
        ]);
        yield* harness.mirror.stop(TASK_ID);
        assert.isTrue(
          harness.messageEvents().some((event) => event.message.text === "Late final answer."),
        );
        const openTool = harness
          .itemEvents()
          .filter(
            (event) =>
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.nativeItemRef?.nativeId === "toolu-open",
          )
          .at(-1)?.turnItem;
        assert.equal(openTool?.status, "completed");

        const readsAfterStop = harness.readerCalls.length;
        const eventsAfterStop = harness.events.length;
        harness.setTranscript([
          promptMessage,
          makeAssistantMessage({ uuid: "uuid-a3", text: "Must never be mirrored." }),
        ]);
        yield* TestClock.adjust("10 seconds");
        for (let i = 0; i < 100; i++) {
          yield* Effect.yieldNow;
        }
        assert.equal(harness.readerCalls.length, readsAfterStop);
        assert.equal(harness.events.length, eventsAfterStop);
        // A second stop is a no-op.
        yield* harness.mirror.stop(TASK_ID);
        assert.equal(harness.readerCalls.length, readsAfterStop);
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, TestClock.layer()))),
    ),
  );

  it.effect("keeps polling through absent transcripts and recovers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeMirrorHarness;
        harness.setFailReads(true);
        yield* harness.mirror.start(harness.target);
        yield* awaitUntil(() => harness.readerCalls.length >= 1, "failing poll");
        assert.lengthOf(harness.events, 0);
        yield* TestClock.adjust("2 seconds");
        yield* awaitUntil(() => harness.readerCalls.length >= 2, "second failing poll");
        assert.lengthOf(harness.events, 0);

        harness.setFailReads(false);
        harness.setTranscript([
          promptMessage,
          makeAssistantMessage({ uuid: "uuid-a1", text: "Transcript appeared." }),
        ]);
        yield* TestClock.adjust("2 seconds");
        yield* awaitUntil(
          () =>
            harness.messageEvents().some((event) => event.message.text === "Transcript appeared."),
          "recovered mirroring",
        );
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, TestClock.layer()))),
    ),
  );

  it.effect("restarting after stop resumes without duplicating mirrored items", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeMirrorHarness;
        harness.setTranscript([
          promptMessage,
          makeAssistantMessage({ uuid: "uuid-a1", text: "First run answer." }),
        ]);
        yield* harness.mirror.start(harness.target);
        yield* awaitUntil(() => harness.messageEvents().length === 1, "first mirrored message");
        yield* harness.mirror.stop(TASK_ID);

        // Resume (SendMessage re-emits task_started for the same task id).
        harness.setTranscript([
          promptMessage,
          makeAssistantMessage({ uuid: "uuid-a1", text: "First run answer." }),
          makeAssistantMessage({ uuid: "uuid-a2", text: "Resumed answer." }),
        ]);
        yield* harness.mirror.start(harness.target);
        yield* awaitUntil(
          () => harness.messageEvents().some((event) => event.message.text === "Resumed answer."),
          "resumed mirrored message",
        );
        assert.lengthOf(
          harness.messageEvents().filter((event) => event.message.text === "First run answer."),
          1,
        );
      }).pipe(Effect.provide(Layer.merge(idAllocatorLayer, TestClock.layer()))),
    ),
  );
});
