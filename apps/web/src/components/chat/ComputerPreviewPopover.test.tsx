// FILE: ComputerPreviewPopover.test.tsx
// Purpose: Guards what the preview popover renders for a given session phase;
//          hidden when no session is armed, open while live, and the chrome
//          (Stop, expand, close) it offers while an agent drives.
// Layer: Component rendering tests
// Depends on: ComputerPreviewPopover and React server rendering.
//
// Rendered to static markup: every side effect in the component lives in
// `useEffect`, so a server render exercises exactly the render-time phase and
// visibility decisions. The stores are stubbed rather than seeded for the same
// reason: zustand serves its initial state to `useSyncExternalStore`'s server
// snapshot.

import { scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import { EnvironmentId, ThreadId, type ThreadComputerState } from "@spiritdevs/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { threadComputerState } from "../computer/computerTestFixtures";
import type { ComputerImageStreamStatus } from "../computer/useComputerImageStream";
import { ComputerPreviewPopover, ComputerPreviewRail } from "./ComputerPreviewPopover";
import type {
  ComputerPreviewCardSize,
  ComputerPreviewSession,
} from "./ComputerPreviewPopover.logic";

const current: {
  session: ComputerPreviewSession | undefined;
  state: ThreadComputerState | undefined;
  autoOpenComputerPane: boolean;
  tapActive: boolean;
  tapFrameSize: { width: number; height: number } | null;
  tapEnabled: boolean | undefined;
  stillsStreaming: boolean;
  streamStatus: ComputerImageStreamStatus | undefined;
  floating: { x: number; y: number } | undefined;
  primaryEnvironmentId: string | null;
  supported: boolean;
} = vi.hoisted(() => ({
  session: undefined,
  state: undefined,
  autoOpenComputerPane: true,
  tapActive: true,
  tapFrameSize: { width: 960, height: 600 },
  tapEnabled: undefined,
  stillsStreaming: false,
  streamStatus: undefined,
  floating: undefined,
  primaryEnvironmentId: "environment-local",
  supported: true,
}));
const seedThreadState = vi.hoisted(() => vi.fn());

const keyOf = (threadId: string) =>
  scopedThreadKey({
    environmentId: EnvironmentId.make("environment-local"),
    threadId: ThreadId.make(threadId),
  });

vi.mock("../../computerPreviewStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../computerPreviewStore")>();
  return {
    ...actual,
    useComputerPreviewStore: (selector: (store: unknown) => unknown) =>
      selector({
        sessionsByThreadKey: current.session
          ? { [keyOf(current.session.threadId)]: current.session }
          : {},
        agentActiveByThreadKey: {},
        previewLayoutByThreadKey: {},
        floatingByThreadKey: current.floating
          ? { [keyOf(current.session?.threadId ?? "thread-1")]: current.floating }
          : {},
        markPreviewLive: vi.fn(),
        notePreviewLayout: vi.fn(),
        hidePreviewForTask: vi.fn(),
        setPreviewFloating: vi.fn(),
        movePreviewFloating: vi.fn(),
      }),
  };
});

vi.mock("../../computerStateStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../computerStateStore")>();
  return {
    ...actual,
    useComputerStateStore: (selector: (store: unknown) => unknown) =>
      selector({
        threadStates: current.state ? { [keyOf(current.state.threadId)]: current.state } : {},
        lastActions: {},
        inputStoppedByEnvironment: {},
        statusByEnvironment: {},
      }),
  };
});

vi.mock("../computer/useComputerPreviewTap", () => ({
  useComputerPreviewTap: (input: { enabled: boolean }) => {
    current.tapEnabled = input.enabled;
    return { active: current.tapActive, frameSize: current.tapFrameSize };
  },
}));

vi.mock("../computer/useComputerImageStream", () => ({
  useComputerImageStream: () => ({
    status:
      current.streamStatus ?? (current.stillsStreaming ? { kind: "streaming" } : { kind: "idle" }),
    dimensions: null,
  }),
}));

vi.mock("../../hooks/useThreadComputerStateSeed", () => ({
  useThreadComputerStateSeed: seedThreadState,
}));

vi.mock("../../hooks/useComputerSupport", () => ({
  useComputerSupport: () => current.supported,
}));

vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: unknown) => unknown) =>
    selector({
      autoOpenComputerPane: current.autoOpenComputerPane,
      computerPreviewSize: "compact",
    }),
}));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => current.primaryEnvironmentId,
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const THREAD_ID = ThreadId.make("thread-1");
const THREAD_REF = { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID };

function threadState(overrides: Partial<ThreadComputerState> = {}): ThreadComputerState {
  return threadComputerState({
    threadId: THREAD_ID,
    screenSize: { width: 5120, height: 2520 },
    ...overrides,
  });
}

function session(phase: ComputerPreviewSession["phase"]): ComputerPreviewSession {
  return { threadId: THREAD_ID, phase };
}

function render(input?: {
  session?: ComputerPreviewSession;
  state?: ThreadComputerState;
  autoOpenComputerPane?: boolean;
  frame?: boolean;
  /** Tap decoded a frame then went silent: size kept, no longer active. */
  tapQuiet?: boolean;
  stills?: boolean;
  streamStatus?: ComputerImageStreamStatus;
  size?: ComputerPreviewCardSize;
  maxWidthPx?: number;
  floating?: { x: number; y: number };
}) {
  current.session = input?.session;
  current.state = input?.state;
  current.autoOpenComputerPane = input?.autoOpenComputerPane ?? true;
  const tapQuiet = input?.tapQuiet ?? false;
  const withFrame = (input?.frame ?? true) || tapQuiet;
  current.tapActive = withFrame && !tapQuiet;
  current.tapFrameSize = withFrame ? { width: 960, height: 600 } : null;
  current.stillsStreaming = input?.stills ?? false;
  current.streamStatus = input?.streamStatus;
  current.floating = input?.floating;
  return renderToStaticMarkup(
    <ComputerPreviewPopover
      threadRef={THREAD_REF}
      size={input?.size}
      maxWidthPx={input?.maxWidthPx}
    />,
  );
}

/** Whether the card is shown: a closed card stays mounted but hidden from assistive tech. */
function isOpen(markup: string): boolean {
  const card = /<div[^>]*role="region"[^>]*>/.exec(markup)?.[0];
  if (card === undefined) throw new Error("no preview card rendered");
  return !card.includes('aria-hidden="true"');
}

afterEach(() => {
  current.session = undefined;
  current.state = undefined;
  current.autoOpenComputerPane = true;
  current.tapActive = true;
  current.tapFrameSize = { width: 960, height: 600 };
  current.stillsStreaming = false;
  current.streamStatus = undefined;
  current.floating = undefined;
  current.tapEnabled = undefined;
  current.primaryEnvironmentId = "environment-local";
  current.supported = true;
  seedThreadState.mockClear();
});

describe("ComputerPreviewPopover", () => {
  it("renders nothing when the thread has no preview session", () => {
    expect(render()).toBe("");
  });

  it("renders nothing while the automatic preview is disabled", () => {
    expect(render({ session: session("live"), autoOpenComputerPane: false })).toBe("");
  });

  it("renders an armed session closed with its canvas mounted for decode", () => {
    const markup = render({ session: session("armed"), frame: false });
    expect(isOpen(markup)).toBe(false);
    expect(markup).toContain("<canvas");
  });

  it("renders a live session open with the desktop chrome", () => {
    const markup = render({ session: session("live"), state: threadState() });
    expect(isOpen(markup)).toBe(true);
    expect(markup).toContain("960 / 600");
    // Compact is the default footprint: small and glanceable.
    expect(markup).toContain("width:288px");
    expect(markup).not.toContain("Open the Computer pane");
    expect(markup).toContain("Hide the computer preview for the rest of this task");
  });

  it("grows to the large footprint when the size setting asks for it", () => {
    const markup = render({
      session: session("live"),
      state: threadState(),
      size: "large",
      maxWidthPx: 560,
    });
    expect(markup).toContain("width:560px");
  });

  it("renders a live session closed until the first frame arrives", () => {
    const markup = render({ session: session("live"), state: threadState(), frame: false });
    expect(isOpen(markup)).toBe(false);
    expect(markup).toContain("<canvas");
  });

  it("opens on the stills stream where the tap channel does not exist", () => {
    const markup = render({
      session: session("live"),
      state: threadState(),
      frame: false,
      stills: true,
    });
    expect(isOpen(markup)).toBe(true);
  });

  it.each([
    [
      { kind: "error", message: "The preview connection failed." },
      "The preview connection failed.",
    ],
    [{ kind: "unsupported" }, "This browser cannot decode desktop frames."],
  ] as const)(
    "shows a first-frame %s without waiting for a decoded image",
    (streamStatus, message) => {
      const markup = render({
        session: session("live"),
        state: threadState(),
        frame: false,
        streamStatus,
      });
      expect(isOpen(markup)).toBe(true);
      expect(markup).toContain(message);
      expect(markup).toContain('role="status"');
      expect(markup).toContain("<canvas");
    },
  );

  it("does not reopen a dismissed preview because its first frame failed", () => {
    const markup = render({
      session: session("hidden-for-task"),
      state: threadState(),
      frame: false,
      streamStatus: { kind: "error", message: "The preview connection failed." },
    });
    expect(isOpen(markup)).toBe(false);
  });

  it("shows the waiting state, never a picture, when no window frame exists yet", () => {
    // The stills source is window/tab-scoped and the server publishes nothing
    // without a target, so the card must present the calm waiting label
    // instead of drawing anything.
    const markup = render({ session: session("live"), state: threadState(), frame: false });
    expect(markup).toContain("Waiting for the window the agent is using…");
    expect(markup).not.toContain("Waiting for the desktop");
  });

  it("holds the quiet tap's last frame without the waiting label", () => {
    // Once a frame decoded, a source going quiet keeps showing it: the card
    // stays open on the held frame's own aspect with no empty-state label
    // pasted over a live picture.
    const markup = render({ session: session("live"), state: threadState(), tapQuiet: true });
    expect(isOpen(markup)).toBe(true);
    expect(markup).toContain("960 / 600");
    expect(markup).not.toContain("Waiting for the window");
  });

  it("marks the status pill with a static dot, never an animated orb", () => {
    // The live indicator is a plain 6px dot — no ping ring, no colored orb
    // pulsing while the agent works.
    const markup = render({
      session: session("live"),
      state: threadState({ agentActive: true }),
    });
    expect(markup).toContain("Live");
    expect(markup).not.toMatch(/animate-(ping|pulse|spin)/);
  });

  it.each([
    [{ kind: "error", message: "Live view unavailable" }, "Live view unavailable"],
    [{ kind: "unsupported" }, "This browser cannot decode desktop frames."],
  ] as const)("marks a held frame stale when the stream reports %s", (streamStatus, message) => {
    const markup = render({
      session: session("live"),
      state: threadState({ agentActive: true }),
      tapQuiet: true,
      streamStatus,
    });
    expect(isOpen(markup)).toBe(true);
    expect(markup).toContain("<canvas");
    expect(markup).toContain("960 / 600");
    expect(markup).toContain(message);
    expect(markup).toContain('role="status"');
    expect(markup).toContain(">Stale frame</span>");
    expect(markup).not.toContain(">Live</span>");
    expect(markup).not.toMatch(/animate-(ping|pulse|spin)/);
  });

  it("replaces the agent activity while the held frame is unavailable", () => {
    const markup = render({
      session: session("live"),
      state: threadState({ agentActive: true, activity: "Reading clipboard" }),
      tapQuiet: true,
      streamStatus: { kind: "error", message: "Live view unavailable" },
    });
    expect(markup).toContain(">Stale frame</span>");
    expect(markup).not.toContain("Reading clipboard");
  });

  it("shows live activity when the native tap takes over from a failed stills stream", () => {
    const markup = render({
      session: session("live"),
      state: threadState({ agentActive: true }),
      streamStatus: { kind: "error", message: "Live view unavailable" },
    });
    expect(markup).toContain(">Live</span>");
    expect(markup).not.toContain("Live view unavailable");
    expect(markup).not.toContain("Stale frame");
  });

  it("offers only close: the pane is disabled and stopping lives in the composer", () => {
    const markup = render({
      session: session("live"),
      state: threadState({ agentActive: true }),
    });
    expect(markup).not.toContain("Open the Computer pane");
    expect(markup).toContain("Hide the computer preview for the rest of this task");
    expect(markup).not.toContain("Stop the agent controlling");
  });

  it("shows the current live activity instead of a stale action", () => {
    const markup = render({
      session: { ...session("live"), lastActionLabel: "Type text" },
      state: threadState({ agentActive: true, activity: "Reading clipboard" }),
    });
    expect(markup).toContain("Reading clipboard");
    expect(markup).not.toContain("Type text");
  });

  it("stays closed for hidden and ended sessions", () => {
    for (const phase of ["hidden-for-task", "ended"] as const) {
      const markup = render({ session: session(phase), state: threadState() });
      expect(isOpen(markup)).toBe(false);
    }
  });

  it("offers pop-out while docked and dock while floating", () => {
    const docked = render({ session: session("live"), state: threadState() });
    expect(docked).toContain("Float the computer preview as a draggable window");

    const floating = render({
      session: session("live"),
      state: threadState(),
      floating: { x: 120, y: 80 },
    });
    expect(floating).toContain("Dock the computer preview back into the chat rail");
    expect(floating).not.toContain("Float the computer preview");
    expect(floating).toContain("left:120px");
    expect(floating).toContain("top:80px");
  });
});

describe("ComputerPreviewRail", () => {
  it("renders nothing while the automatic preview is disabled", () => {
    current.session = session("live");
    current.autoOpenComputerPane = false;
    expect(renderToStaticMarkup(<ComputerPreviewRail threadRef={THREAD_REF} />)).toBe("");
  });

  it("shows a live session's card", () => {
    current.session = session("live");
    current.state = threadState();
    const markup = renderToStaticMarkup(<ComputerPreviewRail threadRef={THREAD_REF} />);
    expect(isOpen(markup)).toBe(true);
  });

  // After a reload or reconnect there is no preview session yet; the seed is
  // what brings one back and what gives a send the thread's generation.
  it("seeds the open thread's state before any preview exists", () => {
    renderToStaticMarkup(<ComputerPreviewRail threadRef={THREAD_REF} />);
    expect(seedThreadState).toHaveBeenCalledWith(THREAD_REF);
  });

  it("seeds the open thread's state with the automatic preview disabled", () => {
    current.session = session("live");
    current.autoOpenComputerPane = false;
    renderToStaticMarkup(<ComputerPreviewRail threadRef={THREAD_REF} />);
    expect(seedThreadState).toHaveBeenCalledWith(THREAD_REF);
  });

  it("asks nothing of an environment that cannot drive a desktop", () => {
    current.supported = false;
    renderToStaticMarkup(<ComputerPreviewRail threadRef={THREAD_REF} />);
    expect(seedThreadState).not.toHaveBeenCalledWith(THREAD_REF);
  });
});

describe("ComputerPreviewPopover frame sources", () => {
  it("offers the desktop tap for the primary (local) environment", () => {
    render({ session: session("live"), state: threadState() });
    expect(current.tapEnabled).toBe(true);
  });

  it("never draws the local tap for a remote environment's thread", () => {
    current.primaryEnvironmentId = "environment-other";
    const markup = render({
      session: session("live"),
      state: threadState(),
      frame: false,
      stills: true,
    });
    expect(current.tapEnabled).toBe(false);
    expect(isOpen(markup)).toBe(true);
  });
});
