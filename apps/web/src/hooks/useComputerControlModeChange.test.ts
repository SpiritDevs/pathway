import { EnvironmentId, type DesktopComputerHelperState } from "@spiritdevs/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ComposerComputerControlMode } from "../computerControlMode";
import {
  COMPUTER_PERMISSION_KINDS,
  draftRequestsComputerControl,
  readLocalComputerPermissionBridge,
  resolveComputerControlForSend,
  runComputerControlModeChange,
  type ComputerPermissionBridge,
} from "./useComputerControlModeChange.logic";

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

/** Mirrors the hook: a sequence counter decides which request is current. */
function fixture(options: { bridge?: boolean } = {}) {
  const permissions = {
    getState: vi.fn(async () => grantState({ accessibilityPermission: "denied" })),
    startPermissionSetup: vi.fn(async () => grantState()),
  };
  const setControlEnabled = vi.fn(async (enabled: boolean) => ({ enabled, generation: 4 }));
  const setMode = vi.fn();
  const focusComposer = vi.fn();
  const notify = vi.fn();
  let sequence = 0;
  const change = (mode: ComposerComputerControlMode) => {
    const request = ++sequence;
    return runComputerControlModeChange(mode, {
      setControlEnabled,
      setMode,
      permissionBridge:
        options.bridge === false ? null : (permissions as unknown as ComputerPermissionBridge),
      focusComposer,
      isCurrent: () => request === sequence,
      notify,
    });
  };
  return { change, permissions, setControlEnabled, setMode, focusComposer, notify };
}

describe("Computer activation permission guide", () => {
  it.each(["request", "chat"] as const)(
    "opens the shared guide when %s access needs permissions",
    async (mode) => {
      const f = fixture();
      await f.change(mode);
      expect(f.permissions.startPermissionSetup).toHaveBeenCalledExactlyOnceWith(
        COMPUTER_PERMISSION_KINDS,
      );
      expect(f.setControlEnabled).toHaveBeenCalledWith(true);
      expect(f.setMode).toHaveBeenCalledWith(mode, { generation: 4 });
      expect(f.focusComposer).not.toHaveBeenCalled();
    },
  );

  it("skips the guide and prompts when grants already exist", async () => {
    const f = fixture();
    f.permissions.getState.mockResolvedValue(grantState());
    await f.change("request");
    expect(f.focusComposer).toHaveBeenCalledOnce();
    expect(f.permissions.startPermissionSetup).not.toHaveBeenCalled();
  });

  it("does not reopen setup after Off overtakes a permission check", async () => {
    const f = fixture();
    let resolve!: (state: DesktopComputerHelperState) => void;
    f.permissions.getState.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = f.change("request");
    await vi.waitFor(() => expect(f.permissions.getState).toHaveBeenCalledOnce());
    await f.change("off");
    expect(f.setMode).toHaveBeenLastCalledWith("off", { generation: 4 });
    resolve(grantState({ accessibilityPermission: "denied" }));
    await pending;
    expect(f.permissions.startPermissionSetup).not.toHaveBeenCalled();
  });

  it("leaves hosts without a local permission bridge alone", async () => {
    const f = fixture({ bridge: false });
    await f.change("chat");
    expect(f.focusComposer).toHaveBeenCalledOnce();
    expect(f.permissions.getState).not.toHaveBeenCalled();
  });

  it("records Off and explains a reset when the server refuses to enable", async () => {
    const f = fixture();
    f.setControlEnabled.mockResolvedValueOnce({ enabled: false, generation: 7 });
    await f.change("request");
    expect(f.setMode).toHaveBeenCalledWith("off", { generation: 7 });
    expect(f.notify).toHaveBeenCalledWith({
      title: "Computer control was reset",
      description: "Control was reset — invoke /computer-use again for a new task.",
      type: "error",
    });
    expect(f.permissions.getState).not.toHaveBeenCalled();
  });

  it("reports a failed change unless a newer change replaced it", async () => {
    const f = fixture();
    f.setControlEnabled.mockRejectedValueOnce(new Error("offline"));
    await f.change("chat");
    expect(f.notify).toHaveBeenCalledWith({
      title: "Computer control could not be changed",
      description: "offline",
      type: "error",
    });
  });
});

describe("readLocalComputerPermissionBridge", () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  const bridge = {} as ComputerPermissionBridge;

  it("uses the desktop bridge only for the desktop's own environment", () => {
    expect(
      readLocalComputerPermissionBridge({
        environmentId: local,
        localEnvironmentId: local,
        bridge,
      }),
    ).toBe(bridge);
    expect(
      readLocalComputerPermissionBridge({
        environmentId: remote,
        localEnvironmentId: local,
        bridge,
      }),
    ).toBeNull();
    expect(
      readLocalComputerPermissionBridge({
        environmentId: local,
        localEnvironmentId: local,
        bridge: undefined,
      }),
    ).toBeNull();
  });
});

describe("resolveComputerControlForSend", () => {
  it("sends nothing while the setting is off and the text does not invoke", () => {
    expect(
      resolveComputerControlForSend({
        messageText: "open Calculator",
        computerControlEnabled: false,
        generation: 3,
      }),
    ).toEqual({ mode: "off", fields: {} });
  });

  it("enables one request from a leading /computer-use, pinned to the generation", () => {
    expect(
      resolveComputerControlForSend({
        messageText: "/computer-use open Calculator",
        computerControlEnabled: false,
        generation: 3,
      }),
    ).toEqual({ mode: "request", fields: { computerControlGeneration: 3 } });
  });

  it("enables the chat from the setting, defaulting the generation to 0", () => {
    expect(
      resolveComputerControlForSend({
        messageText: "open Calculator",
        computerControlEnabled: true,
        generation: undefined,
      }),
    ).toEqual({
      mode: "chat",
      fields: { enableComputerControl: true, computerControlGeneration: 0 },
    });
  });
});

describe("draftRequestsComputerControl", () => {
  it("follows the live text after Enable, not the mode Enable armed", () => {
    // Enable on a denied card prefixes the draft; the user then deletes it.
    const armed = { prompt: "/computer-use open Notes", computerControlEnabled: false };
    expect(draftRequestsComputerControl(armed)).toBe(true);
    const edited = { prompt: "open Notes", computerControlEnabled: false };
    expect(draftRequestsComputerControl(edited)).toBe(false);
    // The send of that draft carries no Computer intent either, so the card
    // must offer Enable again.
    expect(
      resolveComputerControlForSend({ messageText: edited.prompt, ...edited, generation: 2 }).mode,
    ).toBe("off");
  });

  it("counts a hand-typed command and the chat setting as on", () => {
    expect(
      draftRequestsComputerControl({ prompt: "/computer-use", computerControlEnabled: false }),
    ).toBe(true);
    expect(draftRequestsComputerControl({ prompt: undefined, computerControlEnabled: true })).toBe(
      true,
    );
    expect(draftRequestsComputerControl({ prompt: "", computerControlEnabled: false })).toBe(false);
  });
});
