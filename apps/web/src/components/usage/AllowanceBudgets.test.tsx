import {
  EnvironmentId,
  ProviderInstanceId,
  type ServerProviderUsageSnapshot,
} from "@spiritdevs/contracts";
import type { ProviderAllowanceBudget } from "@spiritdevs/contracts/providerAllowanceBudget";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const state = vi.hoisted(() => ({
  snapshots: [] as ServerProviderUsageSnapshot[],
  budgets: [] as ProviderAllowanceBudget[],
  queriedEnvironments: [] as string[],
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, ...reactHookHarness, useEffect: vi.fn() };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      { environmentId: "laptop", label: "Laptop", serverConfig: { providers: [] } },
      { environmentId: "studio", label: "Studio", serverConfig: { providers: [] } },
    ],
  }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providerUsageLive: ({ environmentId }: { environmentId: string }) => environmentId,
    refreshProviderUsage: Symbol("refresh"),
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (environmentId: string) => {
    state.queriedEnvironments.push(environmentId);
    return { data: environmentId === "studio" ? state.snapshots : [], error: null };
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../hooks/useNowMinute", () => ({ useNowMinute: () => "2026-09-14T00:00:00Z" }));
vi.mock("../contacts/businessToolsCloud", () => ({
  useBusinessToolsCloud: () => ({ client: null, accountID: "owner", request: vi.fn() }),
  useBusinessToolsQuery: () => ({ value: state.budgets }),
}));

import { AllowanceBudgets } from "./AllowanceBudgets";

const target = {
  environmentId: EnvironmentId.make("studio"),
  instanceId: ProviderInstanceId.make("work"),
  provider: "codex" as const,
  displayName: "Work",
};
const scope = { kind: "thread" as const, environmentId: "studio", threadId: "thread-1" };
function snapshot(instanceId: string, accountKey: string, provider: "codex" | "cursor" = "codex") {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    provider,
    accountKey,
    status: "ok",
    limits: [{ window: "Weekly", usedPercent: 50 }],
    updatedAt: "2026-09-14T00:00:00Z",
    usageLines: [],
    source: "test",
  } satisfies ServerProviderUsageSnapshot;
}
function budget(
  id: string,
  accountKey: string,
  provider = "codex",
  threadId = scope.threadId,
): ProviderAllowanceBudget {
  return {
    id,
    companyId: "workspace",
    title: id,
    ownerSubject: "owner",
    scopes: [{ ...scope, threadId }],
    status: "paused",
    revision: 1,
    detail: "",
    createdAt: 0,
    updatedAt: 0,
    allocations: [
      {
        provider,
        accountKey,
        windowKey: "weekly",
        windowLabel: "Weekly",
        resetsAt: Date.now() + 86400000,
        authorizedPercent: 10,
        baselineUsedPercent: 50,
        observedUsedPercent: 50,
        observedAt: Date.now(),
        state: "ready",
        detail: "",
      },
    ],
  };
}
function render() {
  hooks.beginRender();
  return AllowanceBudgets({ companyId: "workspace", scopes: [scope], title: "Thread", target });
}
function click(tree: unknown, label: string) {
  const button = visitElements(
    tree,
    (element) => element.props.children === label && typeof element.props.onClick === "function",
  );
  expect(button).not.toBeNull();
  (button!.props.onClick as () => void)();
}
function options(tree: unknown) {
  const values: string[] = [];
  visitElements(tree, (element) => {
    if (element.type === "option") values.push(String(element.props.value));
    return false;
  });
  return values;
}

describe("provider allowance settings", () => {
  beforeEach(() => {
    hooks.reset();
    state.queriedEnvironments = [];
    state.snapshots = [
      snapshot("personal", "personal-account"),
      snapshot("work", "work-account"),
      snapshot("cursor", "work-account", "cursor"),
    ];
    state.budgets = [];
  });
  it("uses the selected environment and instance when adding an allowance", () => {
    click(render(), "Set allowance");
    expect(options(render())).toEqual([
      JSON.stringify(["work", JSON.stringify(["Weekly", "", "", null])]),
    ]);
    expect(new Set(state.queriedEnvironments)).toEqual(new Set(["studio"]));
  });
  it("shows only budgets for the selected provider account and work", () => {
    state.budgets = [
      budget("work-budget", "work-account"),
      budget("personal-budget", "personal-account"),
      budget("cursor-budget", "work-account", "cursor"),
      budget("other-thread-budget", "work-account", "codex", "other-thread"),
    ];
    const tree = render();
    expect(
      visitElements(tree, (element) => element.props.children === "work-budget"),
    ).not.toBeNull();
    for (const title of ["personal-budget", "cursor-budget", "other-thread-budget"]) {
      expect(visitElements(tree, (element) => element.props.children === title)).toBeNull();
    }
    expect(
      visitElements(tree, (element) => element.props.children === "Remove limit and resume"),
    ).not.toBeNull();
    click(tree, "Authorize new allocation");
    expect(options(render())).toHaveLength(1);
  });
  it("does not fall back to another account when the selected instance has no reading", () => {
    state.snapshots = state.snapshots.filter(
      (snapshot) => snapshot.instanceId !== target.instanceId,
    );
    const button = visitElements(render(), (element) => element.props.children === "Set allowance");
    expect(button?.props.disabled).toBe(true);
  });
  it("keeps all account choices available when renewing an existing multi-account allowance", () => {
    const mixed = budget("mixed", "work-account");
    state.budgets = [
      {
        ...mixed,
        allocations: [...mixed.allocations, ...budget("other", "personal-account").allocations],
      },
    ];
    click(render(), "Authorize new allocation");
    expect(options(render())).toHaveLength(5);
  });
});
