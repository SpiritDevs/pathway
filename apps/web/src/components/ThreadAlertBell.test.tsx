import type { ReactElement } from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { AlertPolicyRow } from "@spiritdevs/contracts/threadAlerts";
import { reactHookHarness as hooks } from "../test/reactHookHarness";
import { visitElements } from "../test/reactElementTree";
import { AlertPolicyChoices, ThreadAlertBell } from "./ThreadAlertBell";

const mutations = vi.hoisted(() => ({ upsert: vi.fn(), ready: true }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => (atom === "ready" ? mutations.ready : mutations),
}));
vi.mock("../threadAlerts/state", () => ({
  threadAlertMutationsAtom: "mutations",
  threadAlertPoliciesReadyAtom: "ready",
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
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
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

function render(policies: readonly AlertPolicyRow[] = []) {
  hooks.beginRender();
  return ThreadAlertBell({ projectKey: "repo", threadKey: "thread", policies }) as ReactElement<
    Record<string, unknown>
  >;
}
function button(tree: ReactElement) {
  return visitElements(tree, (element) => element.type === "button")!;
}
function fire(
  element: ReactElement<Record<string, unknown>>,
  handler: string,
  fields: Record<string, unknown> = {},
) {
  const callback = element.props[handler] as (event: Record<string, unknown>) => void;
  callback({ preventDefault: vi.fn(), stopPropagation: vi.fn(), ...fields });
}

describe("ThreadAlertBell", () => {
  beforeEach(() => {
    hooks.reset();
    mutations.ready = true;
    mutations.upsert.mockReset().mockResolvedValue(null);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it("keeps the prior effective state visible but prevents writes while scopes refresh", () => {
    mutations.ready = false;
    const tree = render([
      { scopeKind: "project", scopeKey: "repo", choices: { completion: true } },
    ]);
    expect(button(tree).props["aria-label"]).toBe("Thread alerts partly on, inherited");
    expect(button(tree).props.disabled).toBe(true);
    fire(button(tree), "onClick");
    expect(mutations.upsert).not.toHaveBeenCalled();
  });
  it("bulk-enables a mixed inherited policy without navigating the row", () => {
    const tree = render([
      { scopeKind: "project", scopeKey: "repo", choices: { completion: true } },
    ]);
    expect(button(tree).props["aria-label"]).toBe("Thread alerts partly on, inherited");
    fire(button(tree), "onClick");
    expect(mutations.upsert).toHaveBeenCalledWith({
      scopeKind: "thread",
      scopeKey: "thread",
      choices: { completion: true, permission: true, input: true, failure: true },
    });
  });
  it("bulk-disables an all-on policy", () => {
    const tree = render([
      {
        scopeKind: "global",
        scopeKey: "global",
        choices: { completion: true, permission: true, input: true, failure: true },
      },
    ]);
    fire(button(tree), "onClick");
    expect(mutations.upsert.mock.calls[0]?.[0].choices).toEqual({
      completion: false,
      permission: false,
      input: false,
      failure: false,
    });
  });
  it.each(["onContextMenu", "onMouseMove", "onKeyDown"])(
    "opens the menu through %s without mutating",
    (handler) => {
      fire(button(render()), handler, { ctrlKey: true, key: "Enter" });
      expect(render().props.open).toBe(true);
      expect(mutations.upsert).not.toHaveBeenCalled();
    },
  );
  it("ordinary hover leaves the menu closed", () => {
    fire(button(render()), "onMouseMove");
    expect(render().props.open).toBe(false);
  });
  it("long press opens the menu and suppresses its synthesized click", () => {
    vi.useFakeTimers();
    fire(button(render()), "onPointerDown", { pointerType: "touch" });
    vi.advanceTimersByTime(500);
    fire(button(render()), "onPointerUp");
    fire(button(render()), "onClick");
    expect(render().props.open).toBe(true);
    expect(mutations.upsert).not.toHaveBeenCalled();
  });
  it("a cancelled touch gesture does not open the menu", () => {
    vi.useFakeTimers();
    fire(button(render()), "onPointerDown", { pointerType: "touch" });
    fire(button(render()), "onPointerCancel");
    vi.advanceTimersByTime(500);
    expect(render().props.open).toBe(false);
  });
  it("can restore one event to inherit without changing another override", () => {
    const change = vi.fn();
    const tree = AlertPolicyChoices({
      choices: { completion: false, failure: true },
      inherited: { completion: true, permission: false, input: false, failure: false },
      onChange: change,
    });
    const select = visitElements(tree, (element) => element.props["aria-label"] === "Completion")!;
    fire(select, "onChange", { target: { value: "inherit" } });
    expect(change).toHaveBeenCalledWith({ failure: true });
  });
});
