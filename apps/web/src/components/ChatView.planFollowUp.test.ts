// @effect-diagnostics nodeBuiltinImport:off - Runs ChatView's own plan follow-up callback, which only exists inside the component.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";

import { ThreadId } from "@spiritdevs/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { threadComputerState } from "./computer/computerTestFixtures";
import { resolveComputerControlForSend } from "../hooks/useComputerControlModeChange.logic";

const harness = vi.hoisted(() => ({ runAtomCommand: vi.fn() }));
vi.mock("@spiritdevs/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@spiritdevs/client-runtime/state/runtime")>()),
  runAtomCommand: harness.runAtomCommand,
}));

const { readComputerControlGenerationForSend } =
  await import("../hooks/useThreadComputerStateSeed");
const { useComputerStateStore } = await import("../computerStateStore");

// Mounting ChatView needs the whole app, so this compiles the production
// callback out of the component source and runs it against stub closures.
function loadPlanFollowUp(deps: Record<string, unknown>) {
  const source = NodeFS.readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
  const begin = source.indexOf("  async function onSubmitPlanFollowUp(");
  const end = source.indexOf("\n  const onImplementPlanInNewThread", begin);
  expect(begin).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(begin);
  const callback = NodeModule.stripTypeScriptTypes(source.slice(begin, end));
  // oxlint-disable-next-line no-new-func -- evaluates the extracted production callback
  const factory = new Function(...Object.keys(deps), `${callback}\nreturn onSubmitPlanFollowUp;`);
  return factory(...Object.values(deps)) as (input: {
    text: string;
    interactionMode: "default" | "plan";
  }) => Promise<void>;
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Stub closures for the callback, with the reads and dispatch the test controls. */
function planFollowUpDeps(overrides: Record<string, unknown>) {
  let sequence = 0;
  const noop = () => {};
  return {
    activeThread: { id: "thread", environmentId: "env", title: "Plan" },
    isServerThread: true,
    isSendBusy: false,
    isConnecting: false,
    sendInFlightRef: { current: false },
    requireConversationStorage: () => true,
    composerRef: {
      current: {
        getSendContext: () => ({ providerAvailable: true, selectedModelSelection: {} }),
      },
    },
    newMessageId: () => `message-${++sequence}`,
    resolveComputerControlForSend,
    computerControlSetting: true,
    readComputerControlGenerationForSend,
    appAtomRegistry: {},
    activeThreadRef: { environmentId: "env", threadId: "thread" },
    threadComputerControlGeneration: undefined,
    formatOutgoingPrompt: ({ text }: { text: string }) => text,
    beginLocalDispatch: noop,
    setThreadError: noop,
    threadHistoryRef: { current: null },
    isAtEndRef: { current: false },
    timelineScrollModeRef: { current: null },
    liveFollowUserScrollGenerationRef: { current: 0 },
    anchorUserScrollGenerationRef: { current: 0 },
    setTimelineLiveFollowEnabled: noop,
    pendingTimelineAnchorRef: { current: null },
    activeTimelineAnchorIndexRef: { current: null },
    showScrollDebouncer: { current: { cancel: noop } },
    setShowScrollToBottom: noop,
    setTimelineAnchor: noop,
    scopedThreadKey: () => "",
    scopeThreadRef: () => ({}),
    setOptimisticUserMessages: noop,
    setComposerDraftInteractionMode: noop,
    startThreadTurn: vi.fn(async () => ({ _tag: "Success" })),
    environmentId: "env",
    runtimeMode: "full-access",
    activeProposedPlan: null,
    resetLocalDispatch: noop,
    isAtomCommandInterrupted: () => false,
    squashAtomCommandFailure: () => new Error(),
    ...overrides,
  };
}

describe("ChatView plan follow-up", () => {
  it("submits once when clicked twice while the generation read is pending", async () => {
    const generation = deferred<number>();
    const read = vi.fn(() => generation.promise);
    const start = vi.fn(async () => ({ _tag: "Success" }));
    const sendInFlightRef = { current: false };
    const submit = loadPlanFollowUp(
      planFollowUpDeps({
        sendInFlightRef,
        readComputerControlGenerationForSend: read,
        startThreadTurn: start,
      }),
    );

    const first = submit({ text: "Implement this plan", interactionMode: "default" });
    const second = submit({ text: "Implement this plan", interactionMode: "default" });
    expect(sendInFlightRef.current).toBe(true);
    generation.resolve(1);
    await Promise.all([first, second]);

    expect(read).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(sendInFlightRef.current).toBe(false);
  });

  it("drops the follow-up when its environment is removed while the generation read is pending", async () => {
    const answer = deferred<unknown>();
    harness.runAtomCommand.mockReturnValue(answer.promise);
    const start = vi.fn(async () => ({ _tag: "Success" }));
    const beginLocalDispatch = vi.fn();
    const sendInFlightRef = { current: false };
    const submit = loadPlanFollowUp(
      planFollowUpDeps({ sendInFlightRef, startThreadTurn: start, beginLocalDispatch }),
    );

    const pending = submit({ text: "Implement this plan", interactionMode: "default" });
    useComputerStateStore.getState().clearEnvironment("env" as never);
    answer.resolve(
      AsyncResult.success(
        threadComputerState({ threadId: ThreadId.make("thread"), controlGeneration: 3 }),
      ),
    );
    await pending;

    expect(start).not.toHaveBeenCalled();
    expect(beginLocalDispatch).not.toHaveBeenCalled();
    expect(sendInFlightRef.current).toBe(false);
    expect(useComputerStateStore.getState().threadStates).toEqual({});
  });
});
