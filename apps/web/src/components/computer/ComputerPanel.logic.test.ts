import { ComputerWindowId, type ComputerFrameHeader } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  computerActionLabel,
  computerActionStatusLabel,
  computerCanvasLabel,
  createComputerFrameGateState,
  resolveComputerHealthBadge,
  shouldSubscribeToComputerStream,
  stepComputerFrameGate,
} from "./ComputerPanel.logic";
import { connectedComputerHealth, threadComputerState } from "./computerTestFixtures";

const COMPUTER_ID = "desktop";

function header(sequence: number, computerId = COMPUTER_ID): ComputerFrameHeader {
  return {
    computerId,
    sequence,
    timestampMs: 1,
    keyframe: true,
    codecConfig: false,
  } as ComputerFrameHeader;
}

describe("computer frame gate", () => {
  it("accepts the first frame and rejects frames for another computer", () => {
    const initial = createComputerFrameGateState();
    const wrong = stepComputerFrameGate(initial, header(1, "other"), COMPUTER_ID);
    expect(wrong.action).toBe("ignore");
    expect(wrong.state).toEqual(initial);

    const first = stepComputerFrameGate(initial, header(7), COMPUTER_ID);
    expect(first.action).toBe("decode");
    expect(first.requestResync).toBe(false);
    expect(first.state.lastSequence).toBe(7);
  });

  it("drops duplicates and stale sequence numbers", () => {
    const current = stepComputerFrameGate(createComputerFrameGateState(), header(10), COMPUTER_ID);
    const duplicate = stepComputerFrameGate(current.state, header(10), COMPUTER_ID);
    const stale = stepComputerFrameGate(current.state, header(9), COMPUTER_ID);

    expect(duplicate.action).toBe("drop-stale");
    expect(stale.action).toBe("drop-stale");
    expect(duplicate.requestResync).toBe(false);
    expect(stale.requestResync).toBe(false);
  });

  it("accepts standalone frames after a gap and asks the source to resync", () => {
    const current = stepComputerFrameGate(createComputerFrameGateState(), header(10), COMPUTER_ID);
    const next = stepComputerFrameGate(current.state, header(13), COMPUTER_ID);

    expect(next.action).toBe("decode");
    expect(next.requestResync).toBe(true);
    expect(next.state.lastSequence).toBe(13);
  });

  it("handles uint32 sequence wraparound", () => {
    const current = stepComputerFrameGate(
      createComputerFrameGateState(),
      header(0xffff_fffe),
      COMPUTER_ID,
    );
    const wrapped = stepComputerFrameGate(current.state, header(1), COMPUTER_ID);

    expect(wrapped.action).toBe("decode");
    expect(wrapped.requestResync).toBe(true);
  });
});

describe("computer panel state helpers", () => {
  it("badges a degraded backend and stays silent while it is connected", () => {
    expect(resolveComputerHealthBadge(connectedComputerHealth())).toBeNull();
    expect(resolveComputerHealthBadge(undefined)).toBeNull();

    const reconnecting = resolveComputerHealthBadge({
      ...connectedComputerHealth(),
      status: "reconnecting",
      consecutiveFailures: 3,
      reconnects: 1,
      captureAvailable: false,
      lastFailure: { message: "The backend vanished", at: "2026-08-16T10:00:00.000Z" },
    });
    expect(reconnecting).toMatchObject({
      label: "Reconnecting to desktop",
      tone: "warning",
      pulse: true,
    });
    expect(reconnecting?.title).toContain("The backend vanished");
    expect(reconnecting?.title).toContain("3");
    expect(reconnecting?.title).toContain("Reconnected once since startup.");

    // Non-connected with a clean record is the lazy backend that has simply
    // never been engaged — the server does not connect at boot — and must not
    // flash "unavailable" at every pane open on a healthy desktop.
    expect(
      resolveComputerHealthBadge({ ...connectedComputerHealth(), status: "unavailable" }),
    ).toBeNull();
    expect(
      resolveComputerHealthBadge({
        ...connectedComputerHealth(),
        status: "unavailable",
        consecutiveFailures: 1,
        lastFailure: { message: "plugin load refused", at: "2026-08-20T10:00:00.000Z" },
      }),
    ).toMatchObject({ label: "Desktop unavailable", tone: "danger", pulse: false });
  });

  it("subscribes only for a visible live available thread", () => {
    expect(
      shouldSubscribeToComputerStream({
        runtimeMode: "live",
        isVisible: true,
        threadState: threadComputerState(),
      }),
    ).toBe(true);
    expect(
      shouldSubscribeToComputerStream({
        runtimeMode: "preview",
        isVisible: true,
        threadState: threadComputerState(),
      }),
    ).toBe(false);
    expect(
      shouldSubscribeToComputerStream({
        runtimeMode: "live",
        isVisible: true,
        threadState: threadComputerState({
          availability: { kind: "backend-unavailable", message: "off" },
        }),
      }),
    ).toBe(false);
  });
});

describe("computerCanvasLabel", () => {
  it("names the backend it is actually a picture of", () => {
    expect(
      computerCanvasLabel({
        availability: { kind: "available", backend: "mac" },
        visibleDesktop: true,
      }),
    ).toBe("This Mac's desktop");
    expect(
      computerCanvasLabel({
        availability: { kind: "available", backend: "nested-kwin" },
        visibleDesktop: false,
      }),
    ).toBe("The agent's own desktop");
    expect(
      computerCanvasLabel({
        availability: { kind: "available", backend: "kwin" },
        visibleDesktop: true,
      }),
    ).toBe("This computer's desktop");
    expect(computerCanvasLabel({ availability: undefined, visibleDesktop: false })).toBe(
      "The agent's desktop",
    );
  });
});

describe("computerActionLabel", () => {
  it("uses the same curated labels as approvals and transcripts", () => {
    expect(computerActionLabel({ action: "computer_click", ok: true })).toBe("Click");
    expect(computerActionLabel({ action: "computer_set_value", ok: true })).toBe("Set a field");
    expect(computerActionLabel({ action: "computer_select_text", ok: true })).toBe("Select text");
    expect(computerActionLabel({ action: "computer_perform_action", ok: true })).toBe(
      "Activate a control",
    );
    expect(computerActionLabel({ action: "computer_unknown_action", ok: true })).toBe(
      "Unknown action",
    );
    expect(computerActionLabel(undefined)).toBeNull();
  });

  it("keeps a failure's own message, which is the part worth the space", () => {
    expect(
      computerActionLabel({ action: "computer_click", ok: false, message: "window moved" }),
    ).toBe("Click failed: window moved");
    expect(computerActionLabel({ action: "computer_click", ok: false })).toBe("Click failed");
  });
});

describe("computerActionStatusLabel", () => {
  it("describes delivery without implying a foreground action kept focus", () => {
    const windowId = ComputerWindowId.make("window-1");
    expect(
      computerActionStatusLabel(
        {
          type: "computer.action",
          action: "computer_type_text",
          ok: true,
          windowId,
          delivery: { path: "cua-foreground", verified: "confirmed" },
        },
        [
          {
            id: windowId,
            appName: "TextEdit",
            title: "Untitled",
            focused: false,
            minimized: false,
            visible: true,
          },
        ],
      ),
    ).toBe("Type · TextEdit · Temporary foreground");
  });
});
