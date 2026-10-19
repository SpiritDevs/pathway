import type { ReactElement } from "react";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  EnvironmentId,
  ThreadId,
  type OrchestrationV2WorkspaceCleanupNotice,
} from "@spiritdevs/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../test/reactHookHarness";
import { visitElements } from "../test/reactElementTree";
import {
  EnvironmentWorkspaceCleanupNotices,
  WorkspaceCleanupNotice,
  WorkspaceCleanupNoticeHost,
} from "./WorkspaceCleanupNoticeHost";
import { Button } from "./ui/button";

const state = vi.hoisted(() => ({
  notices: null as
    | readonly import("@spiritdevs/contracts").OrchestrationV2WorkspaceCleanupNotice[]
    | null,
  effects: [] as Array<() => void>,
  query: vi.fn(),
  subscription: vi.fn((target: unknown) => target),
  retry: vi.fn(),
  environments: [] as Array<Record<string, unknown>>,
}));
vi.mock("../state/workspaceCleanup", () => ({
  workspaceCleanupNotices: state.subscription,
  retryWorkspaceCleanup: "retry",
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.retry }));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    state.query(atom);
    return { data: atom === null ? null : state.notices };
  },
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
    useEffect: (callback: () => void) => state.effects.push(callback),
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

const environmentId = EnvironmentId.make("remote-environment");
const notice: OrchestrationV2WorkspaceCleanupNotice = {
  effectId: "cleanup-one",
  threadId: ThreadId.make("deleted-thread"),
  title: "Prepare launch notes",
  message: "Could not remove its worktree.",
  nextAttemptAt: "2026-09-08T01:00:00Z",
};
const props = { environmentId, environmentLabel: "Remote Mac", connected: true };
function renderEnvironment(connected = true) {
  hooks.beginRender();
  const result = EnvironmentWorkspaceCleanupNotices({ ...props, connected });
  for (const effect of state.effects.splice(0)) effect();
  return result;
}
function renderNotice(connected = true) {
  hooks.beginRender();
  return WorkspaceCleanupNotice({ ...props, connected, notice });
}
function retryButton(tree: ReactElement) {
  return visitElements(tree, (element) => element.type === Button)!;
}

beforeEach(() => {
  hooks.reset();
  state.effects = [];
  state.notices = [notice];
  state.query.mockClear();
  state.subscription.mockClear();
  state.retry.mockReset().mockResolvedValue({ _tag: "Success" });
  state.environments = [];
});

describe("workspace cleanup notices", () => {
  it("keeps the named failure visible across disconnect without subscribing while offline", () => {
    expect(renderEnvironment()[0]?.props.notice).toEqual(notice);
    state.subscription.mockClear();
    state.notices = null;
    const offline = renderEnvironment(false);
    expect(offline[0]?.props.notice).toEqual(notice);
    expect(offline[0]?.props.connected).toBe(false);
    expect(state.subscription).not.toHaveBeenCalled();
    expect(state.query).toHaveBeenLastCalledWith(null);
  });

  it("keeps pending automatic retries visible and removes them only when the server clears them", () => {
    renderEnvironment();
    state.notices = [{ ...notice, nextAttemptAt: null }];
    expect(renderEnvironment()).toHaveLength(1);
    state.notices = [];
    expect(renderEnvironment()).toHaveLength(0);
    expect(renderEnvironment(false)).toHaveLength(0);
  });

  it("retries the owning environment's effect without dismissing the notice", async () => {
    const tree = renderNotice();
    expect(JSON.stringify(tree)).toContain("Prepare launch notes");
    expect(JSON.stringify(tree)).toContain("Remote Mac");
    (retryButton(tree).props.onClick as () => void)();
    await state.retry.mock.results[0]?.value;
    expect(state.retry).toHaveBeenCalledWith({
      environmentId,
      input: { effectId: notice.effectId },
    });
    expect(retryButton(renderNotice()).props.disabled).toBe(false);
    expect(JSON.stringify(renderNotice())).toContain("Prepare launch notes");
  });

  it("keeps the notice and reports a rejected Retry", async () => {
    state.retry.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("Environment is unavailable."))),
    );
    (retryButton(renderNotice()).props.onClick as () => void)();
    await state.retry.mock.results[0]?.value;
    const tree = renderNotice();
    expect(visitElements(tree, (element) => element.props.role === "alert")?.props.children).toBe(
      "Environment is unavailable.",
    );
    expect(JSON.stringify(tree)).toContain("Prepare launch notes");
    expect(retryButton(tree).props.disabled).toBe(false);
  });

  it("disables manual retries while disconnected", () => {
    const button = retryButton(renderNotice(false));
    expect(button.props.disabled).toBe(true);
    (button.props.onClick as () => void)();
    expect(state.retry).not.toHaveBeenCalled();
  });

  it("creates one environment watcher for each capable environment", () => {
    state.environments = [
      {
        environmentId,
        label: "Remote Mac",
        descriptor: { capabilities: { threadConversations: true } },
        connection: { phase: "connected" },
      },
      {
        environmentId: "legacy",
        label: "Old server",
        descriptor: { capabilities: {} },
        connection: { phase: "connected" },
      },
      {
        environmentId: "offline",
        label: "Offline",
        descriptor: { capabilities: { threadConversations: true } },
        connection: { phase: "disconnected" },
      },
    ];
    hooks.beginRender();
    const host = WorkspaceCleanupNoticeHost();
    expect(host.props.children).toHaveLength(2);
    expect(host.props.children[0].props).toMatchObject({ environmentId, connected: true });
    expect(host.props.children[1].props).toMatchObject({
      environmentId: "offline",
      connected: false,
    });
  });
});
