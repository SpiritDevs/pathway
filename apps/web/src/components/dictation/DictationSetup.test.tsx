import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  DictationCommand,
  DictationPreferences,
  DictationState,
} from "@spiritdevs/contracts/dictation";
import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const effects = vi.hoisted(() => [] as (() => void | (() => void))[]);
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
    useRef: reactHookHarness.useRef,
    useMemo: reactHookHarness.useMemo,
    useCallback: reactHookHarness.useCallback,
    useEffect: (effect: () => void | (() => void)) => {
      effects.push(effect);
    },
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

import { DictationSetup } from "./DictationSetup";
import { DictationSetupDialog } from "./DictationSetupDialog";
import { makeDictationFixture } from "./fixtures";

function actions(initial = makeDictationFixture("setup")) {
  let current = initial;
  return {
    state: initial,
    execute: vi.fn(async (_command: DictationCommand): Promise<DictationState | null> => current),
    updatePreferences: vi.fn(async (patch: Partial<DictationPreferences>) => {
      current = { ...current, preferences: { ...current.preferences, ...patch } };
      return current;
    }),
    onClose: vi.fn(),
  };
}
function button(tree: unknown, label: string) {
  const node = visitElements(
    tree,
    (element) =>
      typeof element.props.onClick === "function" &&
      (element.props.children === label ||
        (Array.isArray(element.props.children) && element.props.children.includes(label))),
  );
  if (!node) throw new Error(`Missing button: ${label}`);
  return node.props as { onClick: () => void | Promise<void>; disabled?: boolean };
}
function renderDialog(props: ReturnType<typeof actions>) {
  hooks.beginRender();
  return DictationSetupDialog(props);
}

beforeEach(() => {
  hooks.reset();
  effects.splice(0);
});
afterEach(() => vi.unstubAllGlobals());

describe("dictation setup dialog", () => {
  it("shows only the intro until the in-card setup button is clicked", () => {
    const props = actions();
    hooks.beginRender();
    let tree = DictationSetup(props);
    expect(visitElements(tree, (element) => element.type === DictationSetupDialog)).toBeNull();
    expect(visitElements(tree, (element) => "execute" in element.props)).toBeNull();
    const card = visitElements(tree, (element) => element.type === "section");
    button(card, "Set Up Dictation").onClick();
    hooks.beginRender();
    tree = DictationSetup(props);
    expect(visitElements(tree, (element) => element.type === DictationSetupDialog)).not.toBeNull();
    expect(props.execute).not.toHaveBeenCalled();
  });
  it("refreshes permissions on open and focus, then removes the focus listener on close", async () => {
    const props = actions();
    const listeners = new Map<string, () => void>();
    const remove = vi.fn((name: string) => listeners.delete(name));
    vi.stubGlobal("window", {
      addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
      removeEventListener: remove,
    });
    renderDialog(props);
    const cleanup = effects.map((effect) => effect());
    expect(props.execute).toHaveBeenCalledWith({ type: "permissions", action: "refresh" });
    await props.execute.mock.results[0]!.value;
    await Promise.resolve();
    listeners.get("focus")?.();
    expect(props.execute).toHaveBeenCalledTimes(2);
    for (const dispose of cleanup) dispose?.();
    expect(remove).toHaveBeenCalledWith("focus", expect.any(Function));
  });
  it("downloads only missing recommended models when resuming", async () => {
    const state = makeDictationFixture("setup-models");
    const props = actions({
      ...state,
      models: state.models.map((model) =>
        model.id === "whisper-turbo" ? { ...model, status: "installed" } : model,
      ),
    });
    await button(renderDialog(props), "Download models").onClick();
    expect(props.execute).toHaveBeenCalledExactlyOnceWith({
      type: "download",
      modelId: "qwen-cleanup",
    });
  });
  it("refreshes readiness before enabling and preserves all other preferences", async () => {
    const props = actions(makeDictationFixture("setup-test"));
    await button(renderDialog(props), "Enable dictation").onClick();
    expect(props.execute).toHaveBeenCalledWith({ type: "permissions", action: "refresh" });
    expect(props.updatePreferences).toHaveBeenCalledExactlyOnceWith({
      enabled: true,
      setupComplete: true,
    });
    expect(props.onClose).toHaveBeenCalledOnce();
  });
  it("keeps setup open if permission is revoked before finish", async () => {
    const props = actions(makeDictationFixture("setup-test"));
    props.execute.mockResolvedValue({ ...props.state, microphonePermission: "denied" });
    await button(renderDialog(props), "Enable dictation").onClick();
    expect(props.updatePreferences).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });
  it("cancels an active microphone test before closing, without enabling dictation", async () => {
    const props = actions(makeDictationFixture("setup-test-recording"));
    await button(renderDialog(props), "Finish later").onClick();
    expect(props.execute).toHaveBeenCalledExactlyOnceWith({ type: "cancel" });
    expect(props.updatePreferences).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledOnce();
  });
  it("does not enable the replacement account after an account switch during refresh", async () => {
    const props = actions(makeDictationFixture("setup-test"));
    props.execute.mockResolvedValue({ ...props.state, accountId: "replacement-account" });
    await button(renderDialog(props), "Enable dictation").onClick();
    expect(props.updatePreferences).not.toHaveBeenCalled();
  });
});
