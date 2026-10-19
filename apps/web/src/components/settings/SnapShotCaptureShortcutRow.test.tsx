import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettingsPatch,
  type DesktopSnapShotState,
} from "@spiritdevs/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const effects = vi.hoisted(() => [] as (() => void)[]);
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
    useEffect: (effect: () => void) => effects.push(effect),
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../../state/server", () => ({ primaryServerKeybindingsAtom: {} }));
const bridge = vi.hoisted(() => ({
  setSnapShotShortcutSuppressed: vi.fn().mockResolvedValue(undefined),
  checkSnapShotShortcut: vi.fn().mockResolvedValue({ available: true, message: null }),
}));
vi.mock("../../lib/desktopSnapShot", () => ({ getDesktopSnapShotBridge: () => bridge }));

import { SnapShotCaptureShortcutRow } from "./SnapShotCaptureShortcutRow";

const chord = {
  key: "r",
  modKey: true,
  metaKey: false,
  ctrlKey: false,
  shiftKey: true,
  altKey: false,
};
let settings = DEFAULT_CLIENT_SETTINGS;
let state: DesktopSnapShotState;
const onSave = vi.fn<(patch: ClientSettingsPatch) => Promise<DesktopSnapShotState | undefined>>();

function render(type: "screen" | "region" = "screen") {
  hooks.beginRender();
  return SnapShotCaptureShortcutRow({ type, settings, state, disabled: false, onSave });
}
function mount(type: "screen" | "region" = "screen") {
  render(type);
  for (const effect of effects.splice(0)) effect();
  return render(type);
}
function recorder(tree = render()) {
  const element = visitElements(tree, (node) => "data-keybinding-capture" in node.props);
  if (!element) throw new Error("Missing shortcut recorder");
  return element.props;
}
function button(label: string, tree = render()) {
  const element = visitElements(
    tree,
    (node) => node.props.children === label && typeof node.props.onClick === "function",
  );
  if (!element) throw new Error(`Missing ${label} button`);
  return element.props;
}
async function record() {
  (recorder().onClick as () => void)();
  await bridge.setSnapShotShortcutSuppressed.mock.results.at(-1)!.value;
  (recorder().onKeyDown as (event: object) => void)({
    key: "r",
    code: "KeyR",
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    repeat: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  });
  await Promise.resolve();
}

beforeEach(() => {
  hooks.reset();
  effects.length = 0;
  vi.clearAllMocks();
  vi.stubGlobal("navigator", { platform: "Linux" });
  settings = { ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: true };
  state = {
    mode: "direct",
    captureTypes: ["window", "screen", "region"],
    shortcut: settings.snapShotShortcut,
    shortcutRegistered: true,
    shortcutMessage: null,
    message: null,
  };
  bridge.checkSnapShotShortcut.mockResolvedValue({ available: true, message: null });
  onSave.mockImplementation(async (patch) => {
    settings = { ...settings, ...patch };
    return state;
  });
});
afterEach(() => vi.unstubAllGlobals());

it("records and saves an independent current-screen shortcut", async () => {
  const tree = mount();
  expect(tree.props.status).toBe("No shortcut assigned.");
  expect(recorder(tree).children).toBe("Choose shortcut");
  await record();
  expect(button("Save").disabled).toBe(false);
  (button("Save").onClick as () => void)();
  await onSave.mock.results[0]!.value;
  expect(onSave).toHaveBeenCalledExactlyOnceWith({ snapShotScreenShortcut: chord });
  expect(settings.snapShotShortcut).toEqual(DEFAULT_CLIENT_SETTINGS.snapShotShortcut);
});

it("rejects a shortcut already assigned to region capture before probing the OS", async () => {
  settings = { ...settings, snapShotRegionShortcut: chord };
  mount();
  await record();
  expect(render().props.status).toContain('"Capture region"');
  expect(button("Save").disabled).toBe(true);
  expect(bridge.checkSnapShotShortcut).not.toHaveBeenCalled();
});

it("keeps an OS-reserved shortcut unsaved and displays its reason", async () => {
  bridge.checkSnapShotShortcut.mockResolvedValue({
    available: false,
    message: "Already in use by another app.",
  });
  mount();
  await record();
  expect(render().props.status).toBe("Already in use by another app.");
  expect(button("Save").disabled).toBe(true);
  expect(onSave).not.toHaveBeenCalled();
});

it("allows a saved binding to be cleared even after moving to an unsupported desktop", async () => {
  settings = { ...settings, snapShotScreenShortcut: chord };
  state = { ...state, mode: "portal", captureTypes: ["window"] };
  const tree = mount();
  expect(recorder(tree).disabled).toBe(true);
  expect(tree.props.status).toContain("aren't available");
  (button("Clear", tree).onClick as () => void)();
  await onSave.mock.results[0]!.value;
  expect(onSave).toHaveBeenCalledExactlyOnceWith({ snapShotScreenShortcut: null });
});

it("reports a failed registration separately for the saved region shortcut", () => {
  settings = { ...settings, snapShotRegionShortcut: chord };
  state = {
    ...state,
    captureShortcuts: {
      window: { shortcut: settings.snapShotShortcut, registered: true, message: null },
      screen: { shortcut: null, registered: false, message: null },
      region: { shortcut: chord, registered: false, message: "This shortcut is in use." },
    },
  };
  expect(mount("region").props.status).toBe("This shortcut is in use.");
});
