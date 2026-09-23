// Pins the one "set up computer control" vocabulary the chat card and the
// settings panel share.

import {
  ComputerId,
  type ComputerProvisionResult,
  type ComputerStatusResult,
  type DesktopComputerHelperState,
} from "@spiritdevs/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  COMPUTER_PERMISSION_KINDS,
  computerPermissionSetupSupported,
  computerProvisionErrorToast,
  computerProvisionNote,
  computerProvisionOutcome,
  computerProvisionResultToast,
  computerProvisionStartToast,
  prepareComputerPermissionGuide,
  readLocalComputerPermissionBridge,
} from "./computerProvisioning";

function grantState(
  overrides: Partial<DesktopComputerHelperState> = {},
): DesktopComputerHelperState {
  return {
    supported: true,
    status: "ready",
    message: null,
    appDisplayName: "Pathway",
    accessibilityPermission: "granted",
    inputMonitoringPermission: "granted",
    screenRecordingPermission: "granted",
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("prepareComputerPermissionGuide", () => {
  it("does not probe without a native setup bridge", async () => {
    const getPermissionState = vi.fn();
    await expect(
      prepareComputerPermissionGuide({ getPermissionState, isCurrent: () => true }),
    ).resolves.toBe(true);
    expect(getPermissionState).not.toHaveBeenCalled();
  });

  it("checks real grants before the first task instead of trusting idle server availability", async () => {
    const getPermissionState = vi.fn(async () =>
      grantState({ inputMonitoringPermission: "denied" }),
    );
    const startPermissionSetup = vi.fn().mockResolvedValue(undefined);
    await expect(
      prepareComputerPermissionGuide({
        getPermissionState,
        startPermissionSetup,
        isCurrent: () => true,
      }),
    ).resolves.toBe(false);
    expect(getPermissionState).toHaveBeenCalledExactlyOnceWith(COMPUTER_PERMISSION_KINDS);
    expect(startPermissionSetup).toHaveBeenCalledExactlyOnceWith(COMPUTER_PERMISSION_KINDS);
  });

  it("does not open setup after cancellation overtakes the grant check", async () => {
    let current = true;
    const startPermissionSetup = vi.fn();
    const getPermissionState = vi.fn(async () => {
      current = false;
      return grantState({ screenRecordingPermission: "denied" });
    });
    await expect(
      prepareComputerPermissionGuide({
        getPermissionState,
        startPermissionSetup,
        isCurrent: () => current,
      }),
    ).resolves.toBe(false);
    expect(getPermissionState).toHaveBeenCalledOnce();
    expect(startPermissionSetup).not.toHaveBeenCalled();
  });

  it("continues without setup when all requested grants exist", async () => {
    const startPermissionSetup = vi.fn();
    await expect(
      prepareComputerPermissionGuide({
        getPermissionState: async () => grantState(),
        startPermissionSetup,
        isCurrent: () => true,
      }),
    ).resolves.toBe(true);
    expect(startPermissionSetup).not.toHaveBeenCalled();
  });

  it("never offers Mac grants for an unsupported state", async () => {
    const state = grantState({
      supported: false,
      status: "unsupported",
      accessibilityPermission: "unknown",
      inputMonitoringPermission: "unknown",
      screenRecordingPermission: "unknown",
    });
    const startPermissionSetup = vi.fn();
    expect(computerPermissionSetupSupported(state)).toBe(false);
    expect(computerPermissionSetupSupported(null)).toBe(false);
    await expect(
      prepareComputerPermissionGuide({
        getPermissionState: async () => state,
        startPermissionSetup,
        isCurrent: () => true,
      }),
    ).resolves.toBe(true);
    expect(startPermissionSetup).not.toHaveBeenCalled();
  });

  it("keeps the draft unsent when the native check fails", async () => {
    const startPermissionSetup = vi.fn();
    await expect(
      prepareComputerPermissionGuide({
        getPermissionState: async () => {
          throw new Error("helper unavailable");
        },
        startPermissionSetup,
        isCurrent: () => true,
      }),
    ).rejects.toThrow("helper unavailable");
    expect(startPermissionSetup).not.toHaveBeenCalled();
  });
});

describe("local Computer permission ownership", () => {
  it("uses the desktop bridge only for the desktop app's own primary environment", () => {
    const computer = {};
    vi.stubGlobal("window", { desktopBridge: { computer } });
    expect(readLocalComputerPermissionBridge({ environmentIsDesktopPrimary: true })).toBe(computer);
    expect(readLocalComputerPermissionBridge({ environmentIsDesktopPrimary: false })).toBeNull();
  });

  it("has nothing to offer in a plain browser or a desktop build without the bridge", () => {
    vi.stubGlobal("window", {});
    expect(readLocalComputerPermissionBridge({ environmentIsDesktopPrimary: true })).toBeNull();
    vi.stubGlobal("window", { desktopBridge: {} });
    expect(readLocalComputerPermissionBridge({ environmentIsDesktopPrimary: true })).toBeNull();
  });
});

const READY_STATUS: ComputerStatusResult = {
  computerId: ComputerId.make("computer-1"),
  availability: { kind: "available", backend: "mac" },
  health: {
    status: "connected",
    captureAvailable: true,
    consecutiveFailures: 0,
    reconnects: 0,
  },
  capabilities: {
    windows: true,
    windowBounds: true,
    stacking: true,
    capture: true,
    input: true,
    clipboard: true,
    focus: true,
    raise: true,
    ghostCursor: true,
    visibleDesktop: true,
  },
};

function result(
  overrides: Partial<ComputerStatusResult>,
  summary: string,
): ComputerProvisionResult {
  return { summary, status: { ...READY_STATUS, ...overrides } };
}

const PERMISSION_REQUIRED = {
  availability: {
    kind: "permission-required",
    missing: ["accessibility"],
    message: "needs Accessibility",
    buildSignature: "adhoc",
  },
} satisfies Partial<ComputerStatusResult>;

describe("computerProvisionOutcome", () => {
  it("never reports unsupported or disconnected desktops as ready", () => {
    expect(
      computerProvisionOutcome(
        result(
          { availability: { kind: "unsupported-platform", platform: "win32" } },
          "Unavailable.",
        ),
      ),
    ).toBe("incomplete");
    expect(
      computerProvisionOutcome(
        result(
          { provisionable: false, health: { ...READY_STATUS.health, status: "unavailable" } },
          "Unavailable.",
        ),
      ),
    ).toBe("incomplete");
  });

  it("keeps setup incomplete while a provisionable desktop is disconnected", () => {
    expect(
      computerProvisionOutcome(
        result(
          {
            availability: { kind: "available", backend: "kwin" },
            provisionable: true,
            health: { ...READY_STATUS.health, status: "unavailable" },
          },
          "Still starting.",
        ),
      ),
    ).toBe("incomplete");
  });

  it("is ready only when the refreshed status leaves nothing to set up", () => {
    expect(computerProvisionOutcome(result({}, "Started the helper."))).toBe("ready");
    expect(computerProvisionOutcome(result(PERMISSION_REQUIRED, "Asked macOS."))).toBe(
      "incomplete",
    );
  });
});

describe("computer provision toasts", () => {
  it("names the outstanding grants through the shared ordering", () => {
    const toast = computerProvisionStartToast(["screenRecording", "accessibility"]);
    expect(toast.description).toContain("Accessibility and Screen Recording");
    expect(toast.type).toBe("info");
  });

  it("falls back to general wording when no grant has been named", () => {
    expect(computerProvisionStartToast().description).not.toContain("macOS");
    expect(computerProvisionStartToast().description).not.toContain("Accessibility");
    expect(computerProvisionStartToast([]).description).toContain("permissions Pathway needs");
  });

  it("distinguishes a finished setup from one still missing a grant", () => {
    expect(computerProvisionResultToast(result({}, "All set.")).type).toBe("success");
    const incomplete = computerProvisionResultToast(result(PERMISSION_REQUIRED, "Asked macOS."));
    expect(incomplete.type).toBe("warning");
    // The server's own sentence, not a second account of it.
    expect(incomplete.description).toBe("Asked macOS.");
  });

  it("reports a failure without inventing a reason", () => {
    expect(computerProvisionErrorToast(new Error("build failed")).description).toBe("build failed");
    expect(computerProvisionErrorToast(undefined).description).toBe("The server gave no reason.");
  });
});

describe("computerProvisionNote", () => {
  it("uses brief macOS permission guidance when a grant is missing", () => {
    const note = computerProvisionNote({ isPending: true, missing: ["screenRecording"] });
    expect(note).toContain("Checking Screen Recording");
    expect(note).not.toContain("installs or builds");
    expect(note).not.toContain("password");
  });

  it("says the same three things the toasts do, for a surface with room", () => {
    expect(computerProvisionNote({ isPending: true })).toContain("Setting up");
    expect(computerProvisionNote({ isPending: false, error: new Error("nope") })).toBe(
      "Setting up failed. nope",
    );
    expect(
      computerProvisionNote({ isPending: false, result: result({}, "Started the helper.") }),
    ).toBe("Started the helper.");
    expect(computerProvisionNote({ isPending: false })).toBeUndefined();
  });

  it("lets the in-flight message outrank a previous attempt's outcome", () => {
    expect(computerProvisionNote({ isPending: true, error: new Error("nope") })).toContain(
      "Setting up the agent's desktop",
    );
  });
});
