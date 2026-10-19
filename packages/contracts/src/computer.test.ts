import { Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";

import {
  COMPUTER_ID_MAX_LENGTH,
  COMPUTER_MESSAGE_MAX_LENGTH,
  COMPUTER_SELECT_TEXT_RANGE_MAX,
  ComputerActionResult,
  ComputerAvailability,
  ComputerInputPause,
  ComputerLaunchAppResult,
  ComputerSelectTextInput,
  ComputerSetupRequiredPayload,
  ComputerState,
  ComputerStatusResult,
  ComputerWindow,
  ThreadComputerState,
} from "./computer.ts";

const decodeComputerActionResult = Schema.decodeUnknownSync(ComputerActionResult);
const decodeComputerAvailability = Schema.decodeUnknownSync(ComputerAvailability);
const decodeComputerInputPause = Schema.decodeUnknownSync(ComputerInputPause);
const decodeComputerLaunchAppResult = Schema.decodeUnknownSync(ComputerLaunchAppResult);
const decodeComputerSelectTextInput = Schema.decodeUnknownSync(ComputerSelectTextInput);
const decodeComputerSetupRequiredPayload = Schema.decodeUnknownSync(ComputerSetupRequiredPayload);
const decodeComputerState = Schema.decodeUnknownSync(ComputerState);
const decodeComputerStatusResult = Schema.decodeUnknownSync(ComputerStatusResult);
const decodeComputerWindow = Schema.decodeUnknownSync(ComputerWindow);
const decodeThreadComputerState = Schema.decodeUnknownSync(ThreadComputerState);
const encodeComputerActionResult = Schema.encodeUnknownSync(ComputerActionResult);
const encodeComputerAvailability = Schema.encodeUnknownSync(ComputerAvailability);
const encodeComputerInputPause = Schema.encodeUnknownSync(ComputerInputPause);
const encodeComputerLaunchAppResult = Schema.encodeUnknownSync(ComputerLaunchAppResult);
const encodeComputerSetupRequiredPayload = Schema.encodeUnknownSync(ComputerSetupRequiredPayload);
const encodeComputerState = Schema.encodeUnknownSync(ComputerState);
const encodeComputerStatusResult = Schema.encodeUnknownSync(ComputerStatusResult);
const encodeComputerWindow = Schema.encodeUnknownSync(ComputerWindow);
const encodeThreadComputerState = Schema.encodeUnknownSync(ThreadComputerState);

describe("ComputerWindow observed Space membership", () => {
  const window = {
    id: "cua:1:2",
    title: "Fixture",
    focused: false,
    minimized: false,
    visible: false,
  };

  it("preserves per-display membership without making it mandatory on other platforms", () => {
    for (const input of [
      window,
      { ...window, spaceIds: [], onCurrentSpace: false },
      { ...window, focused: true, keyboardFocused: false },
      { ...window, keyboardFocused: true },
      { ...window, spaceIds: [3, 8], currentSpaceId: 8, onCurrentSpace: true },
    ]) {
      const decoded = decodeComputerWindow(input);
      expect(decoded).toEqual(input);
      expect(encodeComputerWindow(decoded)).toEqual(input);
    }
  });

  it("rejects invalid or lossy native Space identifiers", () => {
    for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3"]) {
      expect(() => decodeComputerWindow({ ...window, spaceIds: [id] })).toThrow();
      expect(() => decodeComputerWindow({ ...window, currentSpaceId: id })).toThrow();
    }
  });
});

function decodes(input: unknown): boolean {
  try {
    decodeComputerAvailability(input);
    return true;
  } catch {
    return false;
  }
}

describe("ComputerAvailability permission-required", () => {
  const PERMISSION_REQUIRED = {
    kind: "permission-required",
    missing: ["accessibility", "screenRecording"],
    message: "Pathway needs Accessibility and Screen Recording to control this Mac.",
    buildSignature: "adhoc",
  } as const;

  it("round-trips the grants, the message and the build signature", () => {
    const decoded = decodeComputerAvailability(PERMISSION_REQUIRED);
    expect(decoded).toEqual(PERMISSION_REQUIRED);
    expect(encodeComputerAvailability(decoded)).toEqual(PERMISSION_REQUIRED);
  });

  it("keeps the other availability kinds decodable", () => {
    expect(decodes({ kind: "available", backend: "mac" })).toBe(true);
    expect(decodes({ kind: "unsupported-platform", platform: "linux" })).toBe(true);
    expect(decodes({ kind: "backend-unavailable", message: "No helper." })).toBe(true);
  });

  it("preserves the responsible app in live permission status across the wire", () => {
    const state = { ...PERMISSION_REQUIRED, bundleId: "com.spiritdevs.pathway.dev" };
    const decoded = decodeComputerAvailability(state);
    expect(encodeComputerAvailability(decoded)).toEqual(state);
    expect(decodes({ ...state, bundleId: "" })).toBe(false);
    expect(decodes({ ...state, bundleId: "x".repeat(257) })).toBe(false);
  });

  it("refuses a permission state that names no grant", () => {
    // An empty list would render as "Computer control needs " on the card, and
    // would mean the backend reported a permission problem it cannot name — a
    // state the setup signal expresses by not producing this kind at all.
    expect(decodes({ ...PERMISSION_REQUIRED, missing: [] })).toBe(false);
  });

  it("refuses an unknown grant name and an unknown signature", () => {
    expect(decodes({ ...PERMISSION_REQUIRED, missing: ["inputMonitoring"] })).toBe(true);
    expect(decodes({ ...PERMISSION_REQUIRED, missing: ["camera"] })).toBe(false);
    expect(decodes({ ...PERMISSION_REQUIRED, buildSignature: "notarized" })).toBe(false);
  });
});

describe("ComputerSetupRequiredPayload", () => {
  it("round-trips the tool, the grants, the build signature and the responsible app", () => {
    const payload = {
      toolName: "computer_list_windows",
      missing: ["accessibility"],
      buildSignature: "adhoc",
      bundleId: "com.spiritdevs.pathway.dev",
    } as const;
    const decoded = decodeComputerSetupRequiredPayload(payload);
    expect(decoded).toEqual(payload);
    expect(encodeComputerSetupRequiredPayload(decoded)).toEqual(payload);
  });

  it("accepts a payload with no signature, and refuses an unknown one", () => {
    // Backends with no permission model report none, and the card simply says
    // nothing about stale grants — but "notarized" is a value nothing produces,
    // and reading it as ad-hoc would put a Terminal command in front of a
    // release user.
    const decodes = (input: unknown): boolean => {
      try {
        decodeComputerSetupRequiredPayload(input);
        return true;
      } catch {
        return false;
      }
    };
    expect(decodes({ toolName: "computer_click", missing: [] })).toBe(true);
    expect(decodes({ toolName: "computer_click", missing: [], buildSignature: "notarized" })).toBe(
      false,
    );
    expect(decodes({ toolName: "computer_click", missing: ["inputMonitoring"] })).toBe(true);
    expect(decodes({ toolName: "computer_click", missing: ["camera"] })).toBe(false);
  });
});

describe("Computer state additions", () => {
  const status = {
    computerId: "desktop",
    availability: { kind: "available", backend: "mac" },
    health: {
      status: "connected",
      consecutiveFailures: 0,
      reconnects: 0,
      captureAvailable: true,
    },
    capabilities: {
      windows: true,
      windowBounds: true,
      stacking: false,
      capture: true,
      input: true,
      clipboard: false,
      focus: true,
      raise: true,
      ghostCursor: true,
      visibleDesktop: true,
    },
  } as const;
  const state = {
    computerId: "desktop",
    windows: [],
    screenSize: { width: 1440, height: 900 },
    capturedAt: "2026-09-08T00:00:00.000Z",
  } as const;
  const threadState = {
    ...status,
    threadId: "computer-test-thread",
    version: 1,
    windows: [],
    screenSize: state.screenSize,
    agentActive: false,
    controlledByOtherThread: false,
    lastError: null,
  } as const;

  it("round-trips pause details through perception and thread state", () => {
    const inputPause = { windowId: "cua:123:456", message: "Waiting for this window." };
    const perception = { ...state, inputPause };
    const thread = { ...threadState, inputPause, activity: "Waiting for you" };
    expect(encodeComputerState(perception)).toEqual(perception);
    expect(decodeComputerState(perception)).toEqual(perception);
    expect(encodeThreadComputerState(thread)).toEqual(thread);
    expect(decodeThreadComputerState(thread)).toEqual(thread);
  });

  it("keeps older state and status payloads valid without optional additions", () => {
    expect(decodeComputerState(state)).toEqual(state);
    expect(decodeThreadComputerState(threadState)).toEqual(threadState);
    expect(decodeComputerStatusResult(status)).toEqual(status);
  });

  it("bounds pause messages and window identifiers at the protocol boundary", () => {
    const pause = {
      windowId: "w".repeat(COMPUTER_ID_MAX_LENGTH),
      message: "m".repeat(COMPUTER_MESSAGE_MAX_LENGTH),
    };
    expect(decodeComputerInputPause(pause)).toEqual(pause);
    expect(() => decodeComputerInputPause({ ...pause, message: `${pause.message}m` })).toThrow();
    expect(() => decodeComputerInputPause({ ...pause, windowId: `${pause.windowId}w` })).toThrow();
    expect(decodeComputerInputPause({ message: "Paused" })).toEqual({
      message: "Paused",
    });
  });

  it("rejects unbounded activity text", () => {
    const bounded = { ...threadState, activity: "a".repeat(128) };
    expect(decodeThreadComputerState(bounded)).toEqual(bounded);
    expect(() => decodeThreadComputerState({ ...bounded, activity: "a".repeat(129) })).toThrow();
  });

  it.each([true, false])("retains an explicit provisionable=%s status", (provisionable) => {
    const input = { ...status, provisionable };
    expect(decodeComputerStatusResult(input)).toEqual(input);
    expect(encodeComputerStatusResult(input)).toEqual(input);
  });
});

describe("ComputerActionResult scroll limits", () => {
  const result = {
    computerId: "desktop",
    action: "scroll",
    scroll: {
      requested: { deltaX: 0, deltaY: 1200 },
      injected: { deltaX: 0, deltaY: 600 },
      limitedTo: { deltaX: 0, deltaY: 600 },
    },
    delivery: { path: "cua", verified: "unconfirmed", effect: "dispatched-unknown" },
  } as const;

  it("preserves the overlap limit and existing Cua effect telemetry", () => {
    expect(decodeComputerActionResult(result)).toEqual(result);
    expect(encodeComputerActionResult(result)).toEqual(result);
  });

  it("rejects non-finite limited distances", () => {
    expect(() =>
      decodeComputerActionResult({
        ...result,
        scroll: { ...result.scroll, limitedTo: { deltaX: 0, deltaY: Infinity } },
      }),
    ).toThrow();
  });
});

describe("ComputerSelectTextInput", () => {
  const input = { label: "Display", start: 2, length: 5 } as const;

  it("accepts a semantic target with an in-bounds range, including a caret", () => {
    expect(decodeComputerSelectTextInput(input)).toEqual(input);
    expect(decodeComputerSelectTextInput({ label: "Display", start: 4, length: 0 })).toEqual({
      label: "Display",
      start: 4,
      length: 0,
    });
    expect(
      decodeComputerSelectTextInput({
        label: "Display",
        start: 0,
        length: COMPUTER_SELECT_TEXT_RANGE_MAX,
      }),
    ).toEqual({ label: "Display", start: 0, length: COMPUTER_SELECT_TEXT_RANGE_MAX });
  });

  it("requires the range fields and rejects negative, fractional, and over-max values", () => {
    for (const bad of [
      { label: "Display" },
      { label: "Display", start: 0 },
      { label: "Display", start: -1, length: 1 },
      { label: "Display", start: 0, length: -1 },
      { label: "Display", start: 1.5, length: 1 },
      { label: "Display", start: 0, length: Number.NaN },
      { label: "Display", start: 0, length: COMPUTER_SELECT_TEXT_RANGE_MAX + 1 },
      { label: "Display", start: COMPUTER_SELECT_TEXT_RANGE_MAX + 1, length: 0 },
    ]) {
      expect(() => decodeComputerSelectTextInput(bad)).toThrow();
    }
  });
});

describe("Computer recovery RPC metadata", () => {
  it("preserves launch identity and failed readiness independently through the wire schema", () => {
    const result = {
      computerId: "desktop",
      app: "com.vendor.Helium",
      pid: 42,
      window: null,
      windowStatus: "no_usable_window",
      windowReason: "off_space",
      focusChangedDuringLaunch: true,
    };
    const wire = encodeComputerLaunchAppResult(result);
    expect(decodeComputerLaunchAppResult(wire)).toEqual(result);
    expect(
      decodeComputerLaunchAppResult({
        computerId: "desktop",
        app: "Helium",
        window: null,
      }),
    ).toEqual({ computerId: "desktop", app: "Helium", window: null });
  });
  it("retains the affected app in a pause and refuses invalid process identities", () => {
    const pause = { windowId: "cua:42:7", pid: 42, message: "Observe again" };
    expect(decodeComputerInputPause(encodeComputerInputPause(pause))).toEqual(pause);
    for (const pid of [0, -1, 1.5, 0x80000000]) {
      expect(() => decodeComputerInputPause({ ...pause, pid })).toThrow();
    }
  });
});
