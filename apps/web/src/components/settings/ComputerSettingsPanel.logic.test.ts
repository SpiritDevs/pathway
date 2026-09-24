import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  ComputerId,
  type ComputerStatusResult,
  type DesktopComputerHelperState,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  COMPUTER_AUTONOMY_OPTIONS,
  computerAutonomyReducesOversight,
  computerCapabilitiesDescription,
  computerCapabilitySummary,
  environmentSupportsComputer,
  resolveComputerScopeAccess,
  resolveComputerSettingsAttention,
} from "./ComputerSettingsPanel.logic";

const CAPABILITIES: ComputerStatusResult["capabilities"] = {
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
};

function status(overrides: Partial<ComputerStatusResult> = {}): ComputerStatusResult {
  return {
    computerId: ComputerId.make("desktop"),
    availability: { kind: "available", backend: "mac" },
    capabilities: CAPABILITIES,
    health: { status: "connected", consecutiveFailures: 0, reconnects: 0, captureAvailable: true },
    ...overrides,
  };
}

const IDLE_HEALTH = {
  status: "unavailable",
  consecutiveFailures: 0,
  reconnects: 0,
  captureAvailable: false,
} as const;

function nativeState(
  overrides: Partial<DesktopComputerHelperState> = {},
): DesktopComputerHelperState {
  return {
    supported: true,
    status: "ready",
    message: null,
    appDisplayName: "Pathway",
    accessibilityPermission: "granted",
    screenRecordingPermission: "granted",
    inputMonitoringPermission: "granted",
    ...overrides,
  };
}

function attention(input: Partial<Parameters<typeof resolveComputerSettingsAttention>[0]>) {
  return resolveComputerSettingsAttention({
    status: undefined,
    statusError: null,
    nativeState: null,
    hasNativeBridge: false,
    ...input,
  });
}

describe("resolveComputerSettingsAttention", () => {
  it("is calm and needs nothing while the desktop is connected", () => {
    const result = attention({ status: status() });
    expect(result).toMatchObject({ show: true, tone: "ready", action: null, backend: "mac" });
    expect(result.title).toBe("Connected to the desktop");
  });

  it("stays quiet while the first status is still loading", () => {
    const result = attention({});
    expect(result.show).toBe(false);
    expect(result.action).toBeNull();
  });

  it("offers Check again, not Set up, when the status could not be read", () => {
    const result = attention({ status: status(), statusError: "Socket closed." });
    expect(result).toMatchObject({
      tone: "error",
      action: "retry",
      title: "Computer status is unavailable",
      description: "Socket closed.",
    });
  });

  it("lets an idle backend read as ready only once macOS confirms every grant", () => {
    const idle = status({ health: IDLE_HEALTH });
    expect(attention({ status: idle }).action).toBe("setup");
    const confirmed = attention({
      status: idle,
      nativeState: nativeState(),
      hasNativeBridge: true,
    });
    expect(confirmed).toMatchObject({ tone: "ready", action: null, grantsConfirmed: true });
    expect(confirmed.title).toBe("All permissions granted");
  });

  it("turns a fresh native denial into a named permission-required row", () => {
    const result = attention({
      status: status({ health: IDLE_HEALTH }),
      nativeState: nativeState({ screenRecordingPermission: "denied" }),
      hasNativeBridge: true,
    });
    expect(result.missingPermissions).toEqual(["screenRecording"]);
    expect(result.title).toBe("Computer control needs Screen Recording");
    expect(result.action).toBe("setup");
  });

  it("surfaces a native setup failure as its own error", () => {
    const result = attention({
      status: status(),
      nativeState: nativeState({
        permissionSetupErrorCode: "permission_setup_identity_mismatch",
        message: "This copy is not the one macOS knows.",
      }),
      hasNativeBridge: true,
    });
    expect(result).toMatchObject({
      tone: "error",
      action: "setup",
      title: "Computer permission setup needs attention",
      description: "This copy is not the one macOS knows.",
    });
  });

  it("marks a connected but blind desktop as a warning", () => {
    const result = attention({
      status: status({ health: { ...IDLE_HEALTH, status: "connected" } }),
    });
    expect(result).toMatchObject({ captureBlocked: true, tone: "warning", action: "setup" });
    expect(result.description).toContain("Screen Recording");
  });

  it("never offers Set up where the desktop app says grants are unsupported", () => {
    const result = attention({
      status: status({ health: IDLE_HEALTH }),
      nativeState: nativeState({ supported: false, status: "unsupported" }),
      hasNativeBridge: true,
    });
    expect(result.action).toBeNull();
  });
});

describe("resolveComputerScopeAccess", () => {
  const base = {
    scope: AuthAccessWriteScope,
    isPrimary: false,
    isElectron: false,
    session: null,
    isPending: false,
    hasError: false,
  } as const;

  it("grants the desktop app everything on its own primary", () => {
    expect(resolveComputerScopeAccess({ ...base, isPrimary: true, isElectron: true })).toBe(
      "granted",
    );
  });

  it("waits for the session, and keeps waiting when it cannot be read", () => {
    expect(resolveComputerScopeAccess({ ...base, isPending: true })).toBe("pending");
    expect(resolveComputerScopeAccess({ ...base, hasError: true })).toBe("pending");
    expect(resolveComputerScopeAccess(base)).toBe("denied");
  });

  it("reads the scope from an authenticated session", () => {
    const session = (scopes: readonly string[] | undefined) => ({
      authenticated: true,
      scopes: scopes as never,
    });
    expect(resolveComputerScopeAccess({ ...base, session: session([AuthAccessWriteScope]) })).toBe(
      "granted",
    );
    expect(
      resolveComputerScopeAccess({
        ...base,
        scope: AuthAccessReadScope,
        session: session([AuthAccessWriteScope]),
      }),
    ).toBe("denied");
    // A remote that predates scope reporting is trusted; a browser primary is not.
    expect(resolveComputerScopeAccess({ ...base, session: session(undefined) })).toBe("granted");
    expect(
      resolveComputerScopeAccess({ ...base, isPrimary: true, session: session(undefined) }),
    ).toBe("denied");
    expect(
      resolveComputerScopeAccess({ ...base, session: { authenticated: false, scopes: [] } }),
    ).toBe("denied");
  });
});

describe("environmentSupportsComputer", () => {
  it("offers Computer on macOS and Linux hosts until a status says otherwise", () => {
    expect(environmentSupportsComputer("darwin", undefined)).toBe(true);
    expect(environmentSupportsComputer("linux", status())).toBe(true);
    expect(
      environmentSupportsComputer(
        "linux",
        status({ availability: { kind: "unsupported-platform", platform: "linux" } }),
      ),
    ).toBe(false);
  });

  it("hides Computer on other or unknown hosts", () => {
    expect(environmentSupportsComputer("win32", undefined)).toBe(false);
    expect(environmentSupportsComputer(undefined, undefined)).toBe(false);
  });
});

describe("Computer policy copy", () => {
  it("flags only the autonomy levels that drop approvals", () => {
    expect(COMPUTER_AUTONOMY_OPTIONS.map((option) => option.value)).toEqual([
      "supervised",
      "per-task",
      "auto",
      "full-access",
    ]);
    expect(
      COMPUTER_AUTONOMY_OPTIONS.filter((option) =>
        computerAutonomyReducesOversight(option.value),
      ).map((option) => option.value),
    ).toEqual(["auto", "full-access"]);
  });
});

describe("computer abilities read-out", () => {
  it("drops screen capture while the OS withholds it", () => {
    expect(computerCapabilitySummary(CAPABILITIES, true)).toContain("screen capture");
    expect(computerCapabilitySummary(CAPABILITIES, false)).not.toContain("screen capture");
    expect(
      computerCapabilitySummary(
        Object.fromEntries(Object.keys(CAPABILITIES).map((key) => [key, false])) as never,
        true,
      ),
    ).toBe("none");
  });

  it("promises the release hotkey only on a visible compositor desktop", () => {
    expect(computerCapabilitiesDescription("mac", CAPABILITIES)).toContain("shares your Mac");
    expect(
      computerCapabilitiesDescription("nested-kwin", { ...CAPABILITIES, visibleDesktop: false }),
    ).toContain("drives its own seat");
  });
});
