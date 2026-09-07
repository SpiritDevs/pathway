import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS } from "@spiritdevs/contracts/settings";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import { NotificationsSettings, ProjectAlertOverride } from "./NotificationsSettings";

const state = vi.hoisted(() => ({
  upsert: vi.fn(),
  ready: true,
  policyError: null as string | null,
  update: vi.fn(),
  permission: vi.fn(),
  test: vi.fn(),
  upload: vi.fn(),
  preview: vi.fn(),
  remove: vi.fn(),
  settings: {} as typeof DEFAULT_CLIENT_SETTINGS.threadAlerts,
}));
vi.mock("@clerk/react", () => ({ useAuth: () => ({ userId: "user" }) }));
vi.mock("../../threadAlerts/state", () => ({
  threadAlertPoliciesAtom: "policies",
  threadAlertPoliciesReadyAtom: "ready",
  threadAlertPoliciesErrorAtom: "policyError",
  threadAlertMutationsAtom: "mutations",
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "policies"
      ? []
      : atom === "ready"
        ? state.ready
        : atom === "policyError"
          ? state.policyError
          : { upsert: state.upsert },
}));
vi.mock("../../hooks/useSettings", () => ({
  getClientSettings: () => ({ ...DEFAULT_CLIENT_SETTINGS, threadAlerts: state.settings }),
  useClientSettings: () => state.settings,
  useUpdateClientSettings: () => state.update,
}));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../threadAlerts/audio", () => ({
  BUILT_IN_ALERT_SOUNDS: [{ id: "default", label: "Pathway default" }],
  previewAlertSound: state.preview,
  saveCustomAlertSound: state.upload,
  removeCustomAlertSound: state.remove,
}));
vi.mock("../../threadAlerts/delivery", () => ({
  getAlertNotificationSupport: vi.fn().mockResolvedValue("available"),
  requestAlertNotificationPermission: state.permission,
  testThreadAlert: state.test,
  openAlertNotificationSettings: vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useEffect: () => {},
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
    useMemo: reactHookHarness.useMemo,
    useCallback: reactHookHarness.useCallback,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
function render() {
  hooks.beginRender();
  return NotificationsSettings();
}
function find(tree: ReactElement, label: string) {
  return visitElements(tree, (element) => element.props["aria-label"] === label)!;
}
function change(tree: ReactElement, label: string, checked: boolean) {
  (find(tree, label).props.onCheckedChange as (checked: boolean) => void)(checked);
}

describe("NotificationsSettings", () => {
  beforeEach(() => {
    hooks.reset();
    state.ready = true;
    state.policyError = null;
    vi.clearAllMocks();
    state.settings = DEFAULT_CLIENT_SETTINGS.threadAlerts;
    state.permission.mockResolvedValue("blocked");
    state.upsert.mockResolvedValue(null);
  });
  it("shows loading while alert policies are pending", () => {
    state.ready = false;
    const status = visitElements(render(), (element) => element.props.role === "status");
    expect(status?.props.children).toContain("Loading thread alert settings...");
  });
  it("explains unavailable cloud controls while device settings remain usable", () => {
    state.ready = false;
    state.policyError =
      "Could not load thread alert settings from Pathway Cloud. Reload Pathway to try again.";
    const tree = render();
    const error = visitElements(tree, (element) => element.props.role === "alert");
    expect(error?.props.children).toContain(state.policyError);
    expect(find(tree, "Completion alerts").props.disabled).toBe(true);
    expect(find(tree, "OS notifications").props.disabled).toBe(false);
  });
  it("prevents project overrides while refreshed scopes load", () => {
    state.ready = false;
    hooks.beginRender();
    const tree = ProjectAlertOverride({ scopeKey: "repo", name: "Project" });
    const choices = visitElements(
      tree,
      (element) => typeof element.props.onChange === "function" && "inherited" in element.props,
    )!;
    expect(choices.props.disabled).toBe(true);
    (choices.props.onChange as (choices: { completion: boolean }) => void)({ completion: true });
    expect(state.upsert).not.toHaveBeenCalled();
  });
  it("disables synced policy changes while refreshed scopes load", () => {
    state.ready = false;
    const tree = render();
    expect(find(tree, "Completion alerts").props.disabled).toBe(true);
    change(tree, "Completion alerts", true);
    expect(state.upsert).not.toHaveBeenCalled();
    expect(find(tree, "OS notifications").props.disabled).toBe(false);
  });
  it("does not request permission on render or when selecting global alert policy", () => {
    const tree = render();
    expect(state.permission).not.toHaveBeenCalled();
    change(tree, "Completion alerts", true);
    expect(state.upsert).toHaveBeenCalledWith({
      scopeKind: "global",
      scopeKey: "global",
      choices: { completion: true, permission: false, input: false, failure: false },
    });
    expect(state.permission).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
  });
  it("requests permission only on enable and retains the preference when blocked", async () => {
    change(render(), "OS notifications", true);
    await Promise.resolve();
    await Promise.resolve();
    expect(state.permission).toHaveBeenCalledOnce();
    expect(state.update).toHaveBeenCalledWith({
      threadAlerts: { ...state.settings, osNotificationsEnabled: true },
    });
    expect(
      visitElements(render(), (element) => element.props.title === "Permission: Blocked"),
    ).not.toBeNull();
  });
  it("disabling OS notifications does not request permission or mutate policy", () => {
    change(render(), "OS notifications", false);
    expect(state.permission).not.toHaveBeenCalled();
    expect(state.upsert).not.toHaveBeenCalled();
  });
  it("removes the previous audio file only after a replacement is saved", async () => {
    const previous = { id: "old", name: "old.wav", mimeType: "audio/wav", size: 10, duration: 1 };
    const replacement = { ...previous, id: "new", name: "new.wav" };
    state.settings = { ...state.settings, soundId: "custom", customSound: previous };
    state.upload.mockResolvedValue(replacement);
    const input = find(render(), "Upload alert sound");
    (input.props.onChange as (event: unknown) => void)({
      target: { files: [{ name: "new.wav" }], value: "new.wav" },
    });
    expect(state.remove).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(state.update).toHaveBeenCalledWith({
      threadAlerts: { ...state.settings, customSound: replacement },
    });
    expect(state.remove).toHaveBeenCalledWith("user", "old");
  });
  it("preserves the old file and selection when decoding the replacement fails", async () => {
    state.upload.mockRejectedValue(new Error("Audio could not be decoded."));
    const input = find(render(), "Upload alert sound");
    (input.props.onChange as (event: unknown) => void)({
      target: { files: [{ name: "bad.wav" }], value: "bad.wav" },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(state.remove).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
  });
  it("uses the explicit test adapter and current local settings without creating policy", () => {
    const testButton = visitElements(
      render(),
      (element) =>
        element.props.children === "Test alert" && typeof element.props.onClick === "function",
    )!;
    (testButton.props.onClick as () => void)();
    expect(state.test).toHaveBeenCalledWith("user", state.settings);
    expect(state.upsert).not.toHaveBeenCalled();
    expect(state.permission).not.toHaveBeenCalled();
  });
});
