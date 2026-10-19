import { scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type ScopedThreadRef,
  type ThreadComputerState,
} from "@spiritdevs/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { threadComputerState } from "./components/computer/computerTestFixtures";
import {
  selectThreadComputerPreviewSession,
  useComputerPreviewStore,
} from "./computerPreviewStore";

const ENV = EnvironmentId.make("environment-1");
const OTHER_ENV = EnvironmentId.make("environment-2");
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");
const REF_A: ScopedThreadRef = { environmentId: ENV, threadId: THREAD_A };
const REF_B: ScopedThreadRef = { environmentId: ENV, threadId: THREAD_B };
const KEY_A = scopedThreadKey(REF_A);
const KEY_B = scopedThreadKey(REF_B);

function threadState(overrides: Partial<ThreadComputerState> = {}): ThreadComputerState {
  return threadComputerState({ threadId: THREAD_A, ...overrides });
}

function session(ref: ScopedThreadRef = REF_A) {
  return selectThreadComputerPreviewSession(ref)(useComputerPreviewStore.getState());
}

beforeEach(() => {
  useComputerPreviewStore.getState().clear();
});

describe("computerPreviewStore surface requests", () => {
  it("arms the owning thread's session on a pane request", () => {
    useComputerPreviewStore.getState().requestPreviewSurface(REF_A);
    expect(session()?.phase).toBe("armed");
  });

  it("re-arms a dismissed session when a new lease requests the surface", () => {
    const store = useComputerPreviewStore.getState();
    store.requestPreviewSurface(REF_A);
    store.markPreviewLive(REF_A);
    store.hidePreviewForTask(REF_A);
    expect(session()?.phase).toBe("hidden-for-task");

    useComputerPreviewStore.getState().requestPreviewSurface(REF_A);
    expect(session()?.phase).toBe("armed");
  });
});

describe("computerPreviewStore agent-activity edges", () => {
  it("arms on a drive turn's rising edge and ends on the falling edge", () => {
    const store = useComputerPreviewStore.getState();
    store.noteThreadComputerState(ENV, threadState({ agentActive: true }));
    expect(session()?.phase).toBe("armed");

    store.noteThreadComputerState(ENV, threadState({ version: 2, agentActive: false }));
    expect(session()?.phase).toBe("ended");
  });

  it("stays hidden for the rest of the task while the same turn keeps driving", () => {
    const store = useComputerPreviewStore.getState();
    store.noteThreadComputerState(ENV, threadState({ agentActive: true }));
    store.markPreviewLive(REF_A);
    store.hidePreviewForTask(REF_A);
    expect(session()?.phase).toBe("hidden-for-task");

    // Same turn still active: no edge, so the dismissal stands.
    store.noteThreadComputerState(ENV, threadState({ version: 2, agentActive: true }));
    expect(session()?.phase).toBe("hidden-for-task");
  });

  it("re-arms on the next turn after a dismissed session", () => {
    const store = useComputerPreviewStore.getState();
    store.noteThreadComputerState(ENV, threadState({ agentActive: true }));
    store.markPreviewLive(REF_A);
    store.hidePreviewForTask(REF_A);
    store.noteThreadComputerState(ENV, threadState({ version: 2, agentActive: false }));
    expect(session()?.phase).toBe("ended");

    store.noteThreadComputerState(ENV, threadState({ version: 3, agentActive: true }));
    expect(session()?.phase).toBe("armed");
  });

  it("treats lease ownership as active across the gaps between tool calls", () => {
    const store = useComputerPreviewStore.getState();
    store.noteThreadComputerState(
      ENV,
      threadState({ agentActive: false, controlOwnerThreadId: THREAD_A }),
    );
    expect(session()?.phase).toBe("armed");
  });

  it("does not arm a bystander thread that only sees the owner named", () => {
    const store = useComputerPreviewStore.getState();
    store.noteThreadComputerState(
      ENV,
      threadState({
        threadId: THREAD_B,
        controlOwnerThreadId: THREAD_A,
        controlledByOtherThread: true,
      }),
    );
    expect(session(REF_B)).toBeUndefined();
  });
});

describe("computerPreviewStore session details", () => {
  it("takes an armed session live only once it is viewed", () => {
    const store = useComputerPreviewStore.getState();
    store.requestPreviewSurface(REF_A);
    store.markPreviewLive(REF_A);
    expect(session()?.phase).toBe("live");

    // A second mark or a mark on a dismissed session changes nothing.
    store.hidePreviewForTask(REF_A);
    store.markPreviewLive(REF_A);
    expect(session()?.phase).toBe("hidden-for-task");
  });

  it("keeps the newest spoken action label on the session", () => {
    const store = useComputerPreviewStore.getState();
    store.noteThreadActionLabel(REF_A, "Click");
    expect(session()?.lastActionLabel).toBe("Click");
    expect(session()?.phase).toBe("armed");

    store.markPreviewLive(REF_A);
    store.noteThreadActionLabel(REF_A, "Type text");
    expect(session()?.lastActionLabel).toBe("Type text");
    expect(session()?.phase).toBe("live");
  });

  it("drops a removed session and clears all state", () => {
    const store = useComputerPreviewStore.getState();
    store.noteThreadComputerState(ENV, threadState({ agentActive: true }));
    store.removePreviewSession(REF_A);
    expect(session()).toBeUndefined();

    store.requestPreviewSurface(REF_A);
    store.requestPreviewSurface(REF_B);
    store.clear();
    expect(useComputerPreviewStore.getState().sessionsByThreadKey).toEqual({});
    expect(useComputerPreviewStore.getState().agentActiveByThreadKey).toEqual({});
  });
});

describe("notePreviewLayout", () => {
  it("reserves space for a first-frame error without claiming a frame", () => {
    const store = useComputerPreviewStore.getState();
    store.notePreviewLayout(REF_A, { hasFrame: false, hasVisibleStatus: false, width: 288 });
    store.notePreviewLayout(REF_A, { hasFrame: false, hasVisibleStatus: true, width: 288 });
    const errorLayout = useComputerPreviewStore.getState().previewLayoutByThreadKey[KEY_A];
    expect(errorLayout).toEqual({ hasFrame: false, hasVisibleStatus: true, width: 288 });
    store.notePreviewLayout(REF_A, { hasFrame: false, hasVisibleStatus: true, width: 288 });
    expect(useComputerPreviewStore.getState().previewLayoutByThreadKey[KEY_A]).toBe(errorLayout);
    store.notePreviewLayout(REF_A, { hasFrame: true, hasVisibleStatus: false, width: 288 });
    expect(useComputerPreviewStore.getState().previewLayoutByThreadKey[KEY_A]).toEqual({
      hasFrame: true,
      hasVisibleStatus: false,
      width: 288,
    });
  });

  it("publishes the card footprint and preserves identity when unchanged", () => {
    const store = useComputerPreviewStore.getState();
    store.notePreviewLayout(REF_A, { hasFrame: false, width: 448 });
    const first = useComputerPreviewStore.getState().previewLayoutByThreadKey[KEY_A];
    expect(first).toEqual({ hasFrame: false, width: 448 });
    store.notePreviewLayout(REF_A, { hasFrame: false, width: 448 });
    expect(useComputerPreviewStore.getState().previewLayoutByThreadKey[KEY_A]).toBe(first);
    store.notePreviewLayout(REF_A, { hasFrame: true, width: 448 });
    expect(useComputerPreviewStore.getState().previewLayoutByThreadKey[KEY_A]).toEqual({
      hasFrame: true,
      width: 448,
    });
  });

  it("drops layout with the session and on clear", () => {
    const store = useComputerPreviewStore.getState();
    store.notePreviewLayout(REF_A, { hasFrame: true, width: 300 });
    store.notePreviewLayout(REF_B, { hasFrame: true, width: 300 });
    store.removePreviewSession(REF_A);
    expect(useComputerPreviewStore.getState().previewLayoutByThreadKey[KEY_A]).toBeUndefined();
    expect(useComputerPreviewStore.getState().previewLayoutByThreadKey[KEY_B]).toEqual({
      hasFrame: true,
      width: 300,
    });
    store.clear();
    expect(useComputerPreviewStore.getState().previewLayoutByThreadKey).toEqual({});
  });
});

describe("preview floating", () => {
  const floatingOf = (ref: ScopedThreadRef) =>
    useComputerPreviewStore.getState().floatingByThreadKey[scopedThreadKey(ref)];

  it("detaches, drags, and re-docks per thread", () => {
    const store = useComputerPreviewStore.getState();
    store.setPreviewFloating(REF_A, { x: 100, y: 60 });
    store.setPreviewFloating(REF_B, { x: 700, y: 40 });
    expect(floatingOf(REF_A)).toEqual({ x: 100, y: 60 });
    store.movePreviewFloating(REF_A, { x: 140, y: 92 });
    expect(floatingOf(REF_A)).toEqual({ x: 140, y: 92 });
    expect(floatingOf(REF_B)).toEqual({ x: 700, y: 40 });
    store.setPreviewFloating(REF_A, null);
    expect(floatingOf(REF_A)).toBeUndefined();
    expect(floatingOf(REF_B)).toEqual({ x: 700, y: 40 });
  });

  it("preserves identity on no-op writes and ignores docked drags", () => {
    const store = useComputerPreviewStore.getState();
    store.movePreviewFloating(REF_A, { x: 10, y: 10 });
    expect(floatingOf(REF_A)).toBeUndefined();
    store.setPreviewFloating(REF_A, { x: 100, y: 60 });
    const first = floatingOf(REF_A);
    store.setPreviewFloating(REF_A, { x: 100, y: 60 });
    store.movePreviewFloating(REF_A, { x: 100, y: 60 });
    expect(floatingOf(REF_A)).toBe(first);
    store.setPreviewFloating(REF_A, null);
    store.setPreviewFloating(REF_A, null);
    expect(floatingOf(REF_A)).toBeUndefined();
  });

  it("drops the floating position with the session and on clear", () => {
    const store = useComputerPreviewStore.getState();
    store.setPreviewFloating(REF_A, { x: 1, y: 2 });
    store.setPreviewFloating(REF_B, { x: 3, y: 4 });
    store.removePreviewSession(REF_A);
    expect(floatingOf(REF_A)).toBeUndefined();
    expect(floatingOf(REF_B)).toEqual({ x: 3, y: 4 });
    store.clear();
    expect(useComputerPreviewStore.getState().floatingByThreadKey).toEqual({});
  });
});

describe("computerPreviewStore environment scoping", () => {
  it("keeps the same thread id in two environments apart", () => {
    const store = useComputerPreviewStore.getState();
    const other: ScopedThreadRef = { environmentId: OTHER_ENV, threadId: THREAD_A };
    store.noteThreadComputerState(ENV, threadState({ agentActive: true }));
    expect(session()?.phase).toBe("armed");
    expect(session(other)).toBeUndefined();

    store.hidePreviewForTask(other);
    expect(session()?.phase).toBe("armed");
  });

  it("clears only the disconnected environment's sessions", () => {
    const store = useComputerPreviewStore.getState();
    const other: ScopedThreadRef = { environmentId: OTHER_ENV, threadId: THREAD_A };
    store.requestPreviewSurface(REF_A);
    store.requestPreviewSurface(other);
    store.setPreviewFloating(REF_A, { x: 1, y: 2 });
    store.notePreviewLayout(other, { hasFrame: true, width: 300 });

    store.clearEnvironment(ENV);
    expect(session()).toBeUndefined();
    expect(session(other)?.phase).toBe("armed");
    expect(useComputerPreviewStore.getState().floatingByThreadKey).toEqual({});
    expect(
      useComputerPreviewStore.getState().previewLayoutByThreadKey[scopedThreadKey(other)],
    ).toEqual({ hasFrame: true, width: 300 });

    const before = useComputerPreviewStore.getState();
    store.clearEnvironment(ENV);
    expect(useComputerPreviewStore.getState()).toBe(before);
  });
});
