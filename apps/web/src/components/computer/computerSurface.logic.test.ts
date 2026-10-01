import {
  ComputerId,
  ThreadId,
  type ComputerSurfaceController,
  type ComputerSurfaceSessionState,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createComputerClickDispatch } from "./computerClickDispatch";
import { createComputerInputQueue } from "./computerInputQueue";
import {
  computerControlView,
  createComputerControlLease,
  drainComputerInput,
  computerHandBackThreadId,
  computerKeyInput,
  computerPointerButton,
  computerSurfacePoint,
} from "./computerSurface.logic";

const agentThread = ThreadId.make("thread-agent");
const openedFrom = ThreadId.make("thread-view");

function session(
  controller: ComputerSurfaceController,
  activeTurns: ComputerSurfaceSessionState["state"]["activeTurns"] = [],
): ComputerSurfaceSessionState {
  return {
    clientId: "me",
    state: {
      computerId: ComputerId.make("desktop"),
      revision: 1,
      controller,
      activeTurns,
      capabilities: { capture: true, input: true, pointerPhases: false },
    },
  };
}

const key = (
  key: string,
  modifiers: Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>> = {},
) => ({
  key,
  ctrlKey: modifiers.ctrl ?? false,
  altKey: modifiers.alt ?? false,
  shiftKey: modifiers.shift ?? false,
  metaKey: modifiers.meta ?? false,
});

describe("computerControlView", () => {
  it("names who holds the screen from this connection's point of view", () => {
    expect(computerControlView(session({ kind: "agent", threadId: agentThread }))).toEqual({
      tone: "agent",
      label: "Agent is using the computer",
      mine: false,
    });
    expect(computerControlView(session({ kind: "client", clientId: "other" }))).toMatchObject({
      tone: "other",
      mine: false,
    });
    expect(computerControlView(session({ kind: "idle" }))).toMatchObject({
      label: "Agent idle",
      mine: false,
    });
  });

  it("says whether an agent is waiting behind this client's control", () => {
    const turn = [{ threadId: agentThread, runId: "run" }];
    expect(computerControlView(session({ kind: "client", clientId: "me" }, turn))).toMatchObject({
      label: "You have control",
      mine: true,
    });
    expect(computerControlView(session({ kind: "client", clientId: "me" }))).toMatchObject({
      label: "Agent idle — you have control",
      mine: true,
    });
  });
});

describe("computerHandBackThreadId", () => {
  it("prefers the paused agent's thread, then the view's thread", () => {
    expect(
      computerHandBackThreadId(
        session({ kind: "client", clientId: "me" }, [{ threadId: agentThread, runId: "run" }]),
        openedFrom,
      ),
    ).toBe(agentThread);
    expect(computerHandBackThreadId(session({ kind: "client", clientId: "me" }), openedFrom)).toBe(
      openedFrom,
    );
  });
});

describe("computerSurfacePoint", () => {
  // A 2880x1800 retina frame is 1440x900 points.
  const screen = { width: 1440, height: 900 };

  it("maps canvas pixels to display points", () => {
    expect(computerSurfacePoint({ x: 360, y: 225, boxWidth: 720, boxHeight: 450, screen })).toEqual(
      { x: 720, y: 450 },
    );
  });

  it("excludes the letterbox", () => {
    // 720x600 box: the image is 720x450, centred with 75px bars above and below.
    expect(computerSurfacePoint({ x: 0, y: 75, boxWidth: 720, boxHeight: 600, screen })).toEqual({
      x: 0,
      y: 0,
    });
    expect(
      computerSurfacePoint({ x: 100, y: 40, boxWidth: 720, boxHeight: 600, screen }),
    ).toBeNull();
  });
});

describe("computerKeyInput", () => {
  it("types printable text and sends everything else as a key", () => {
    expect(computerKeyInput(key("a"))).toEqual({ type: "type", text: "a" });
    expect(computerKeyInput(key("A", { shift: true }))).toEqual({ type: "type", text: "A" });
    expect(computerKeyInput(key("Enter"))).toEqual({ type: "key", key: "Enter" });
    expect(computerKeyInput(key("Escape"))).toEqual({ type: "key", key: "Escape" });
  });

  it("sends chords whole", () => {
    expect(computerKeyInput(key("c", { meta: true }))).toEqual({
      type: "key",
      key: "C",
      modifiers: ["meta"],
    });
    expect(computerKeyInput(key(" ", { ctrl: true }))).toEqual({
      type: "key",
      key: "Space",
      modifiers: ["ctrl"],
    });
    expect(computerKeyInput(key("ArrowUp", { shift: true }))).toEqual({
      type: "key",
      key: "ArrowUp",
      modifiers: ["shift"],
    });
  });

  it("ignores lone modifiers and composition", () => {
    expect(computerKeyInput(key("Shift", { shift: true }))).toBeNull();
    expect(computerKeyInput(key("Dead"))).toBeNull();
    expect(computerKeyInput({ ...key("a"), isComposing: true })).toBeNull();
  });
});

describe("computerPointerButton", () => {
  it("supports the buttons the host can click", () => {
    expect(computerPointerButton(0)).toBe("left");
    expect(computerPointerButton(2)).toBe("right");
    expect(computerPointerButton(1)).toBeNull();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A view's input path: a paired-click dispatcher feeding a serial send queue. */
function inputPath(log: string[]) {
  const queue = createComputerInputQueue();
  const clicks = createComputerClickDispatch({
    // A long pairing wait: only an explicit flush can send the click in time.
    delayMs: 60_000,
    dispatch: ({ clickCount }) => {
      queue.push(async () => {
        await Promise.resolve();
        log.push(`click ${clickCount}`);
      });
    },
  });
  return { queue, clicks };
}

describe("createComputerControlLease", () => {
  it("lands the waiting click and queued typing before handing back", async () => {
    const log: string[] = [];
    const { queue, clicks } = inputPath(log);
    const lease = createComputerControlLease({
      release: async () => log.push("release"),
      drainInput: () => drainComputerInput(clicks, queue),
    });
    const typed = deferred<void>();
    queue.push(async () => {
      await typed.promise;
      log.push("type hello");
    });
    clicks.click({ x: 1, y: 1 }, 1);

    const handedBack = lease.relinquish(async () => {
      log.push("hand back");
      return "done";
    });
    expect(lease.accepting()).toBe(false);
    typed.resolve();

    await expect(handedBack).resolves.toBe("done");
    expect(log).toEqual(["type hello", "click 1", "hand back"]);
  });

  it("reopens input when the hand back kept control", async () => {
    const lease = createComputerControlLease({
      release: async () => undefined,
      drainInput: async () => undefined,
    });
    await lease.relinquish(async () => "failed");
    expect(lease.accepting()).toBe(false);
    lease.resume();
    expect(lease.accepting()).toBe(true);
  });

  it("releases a takeover that lands after the view closed", async () => {
    const log: string[] = [];
    const lease = createComputerControlLease({
      release: async () => log.push("release"),
      drainInput: async () => undefined,
    });
    const granted = deferred<boolean>();
    const acquiring = lease.acquire(() => granted.promise);

    // Unmount while the takeover is in flight: not yet ours, but still owed a release.
    expect(lease.leave(false)).toBe(true);
    expect(log).toEqual([]);
    granted.resolve(true);

    await expect(acquiring).resolves.toBe(false);
    expect(log).toEqual(["release"]);
    expect(lease.accepting()).toBe(false);
  });

  it("does not release a refused takeover", async () => {
    const log: string[] = [];
    const lease = createComputerControlLease({
      release: async () => log.push("release"),
      drainInput: async () => undefined,
    });
    const granted = deferred<boolean>();
    const acquiring = lease.acquire(() => granted.promise);
    lease.leave(false);
    granted.resolve(false);
    await expect(acquiring).resolves.toBe(false);
    expect(log).toEqual([]);
  });

  it("releases held control when the page hides, after queued input", async () => {
    const log: string[] = [];
    const { queue, clicks } = inputPath(log);
    let resolveRelease!: () => void;
    const released = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });
    const lease = createComputerControlLease({
      release: async () => {
        log.push("release");
        resolveRelease();
      },
      drainInput: () => drainComputerInput(clicks, queue),
    });
    clicks.click({ x: 1, y: 1 }, 1);

    expect(lease.leave(true)).toBe(true);
    await released;
    expect(log).toEqual(["click 1", "release"]);
  });

  it("has nothing to release when idle", () => {
    const lease = createComputerControlLease({
      release: async () => undefined,
      drainInput: async () => undefined,
    });
    expect(lease.leave(false)).toBe(false);
  });

  it("a later takeover is not undone by an earlier leave", async () => {
    const log: string[] = [];
    const lease = createComputerControlLease({
      release: async () => log.push("release"),
      drainInput: async () => undefined,
    });
    lease.leave(false);
    await expect(lease.acquire(async () => true)).resolves.toBe(true);
    expect(log).toEqual([]);
    expect(lease.accepting()).toBe(true);
  });
});
