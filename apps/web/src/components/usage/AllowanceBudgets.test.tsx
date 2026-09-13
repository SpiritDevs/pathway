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
  remoteSnapshots: [] as ServerProviderUsageSnapshot[],
  request: vi.fn(),
  refresh: vi.fn(),
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
    return {
      data: environmentId === "studio" ? state.snapshots : state.remoteSnapshots,
      error: null,
    };
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.refresh }));
vi.mock("../../hooks/useNowMinute", () => ({ useNowMinute: () => "2026-09-14T00:00:00Z" }));
vi.mock("../contacts/businessToolsCloud", () => ({
  useBusinessToolsCloud: () => ({ client: null, accountID: "owner", request: state.request }),
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
    limits: [
      {
        window: "Weekly",
        usedPercent: 50,
        fetchedAt: new Date().toISOString(),
        resetsAt: new Date(Date.now() + 86400000).toISOString(),
      },
    ],
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
function field(tree: unknown, name: string) {
  const label = visitElements(
    tree,
    (element) =>
      element.type === "label" &&
      Array.isArray(element.props.children) &&
      element.props.children[0] === name,
  );
  const input = visitElements(label, (element) => typeof element.props.onChange === "function");
  expect(input).not.toBeNull();
  return input!;
}
function change(tree: unknown, name: string, value: string) {
  (field(tree, name).props.onChange as (event: { target: { value: string } }) => void)({
    target: { value },
  });
}
const windowKey = (id: string) => JSON.stringify([id, JSON.stringify(["Weekly", "", "", null])]);

describe("provider allowance settings", () => {
  beforeEach(() => {
    hooks.reset();
    state.queriedEnvironments = [];
    state.snapshots = [
      snapshot("personal", "personal-account"),
      snapshot("work", "work-account"),
      snapshot("cursor", "cursor-account", "cursor"),
    ];
    state.remoteSnapshots = [snapshot("remote-work", "remote-account")];
    state.budgets = [];
    state.request.mockReset();
    state.refresh
      .mockReset()
      .mockImplementation(
        async ({
          environmentId,
          input,
        }: {
          environmentId: string;
          input: { instanceId: string };
        }) => ({
          _tag: "Success",
          value: (environmentId === "studio" ? state.snapshots : state.remoteSnapshots).find(
            (reading) => reading.instanceId === input.instanceId,
          ),
        }),
      );
  });
  it("defaults to the settings provider while offering fallback accounts", () => {
    click(render(), "Set allowance");
    const tree = render();
    expect(field(tree, "Environment").props.value).toBe("studio");
    expect(field(tree, "Account window").props.value).toBe(windowKey("work"));
    for (const id of ["personal", "work", "cursor"]) {
      expect(
        visitElements(
          tree,
          (element) => element.type === "option" && element.props.value === windowKey(id),
        ),
      ).not.toBeNull();
    }
    expect(new Set(state.queriedEnvironments)).toEqual(new Set(["studio"]));
  });
  it("shows all budgets affecting the selected work, across provider accounts", () => {
    state.budgets = [
      budget("work-budget", "work-account"),
      budget("personal-budget", "personal-account"),
      budget("cursor-budget", "cursor-account", "cursor"),
      budget("other-thread-budget", "work-account", "codex", "other-thread"),
    ];
    const tree = render();
    for (const title of ["work-budget", "personal-budget", "cursor-budget"]) {
      expect(visitElements(tree, (element) => element.props.children === title)).not.toBeNull();
    }
    expect(
      visitElements(tree, (element) => element.props.children === "other-thread-budget"),
    ).toBeNull();
  });
  it.each(["changed", "missing"])(
    "keeps removal and renewal available when the account reading is %s",
    (reading) => {
      state.budgets = [budget("old-account-limit", "old-account")];
      state.snapshots = reading === "changed" ? [snapshot("work", "new-account")] : [];
      const tree = render();
      expect(
        visitElements(tree, (element) => element.props.children === "old-account-limit"),
      ).not.toBeNull();
      click(tree, "Remove limit and resume");
      expect(state.request).toHaveBeenCalledWith("providerAllowanceBudgets:close", {
        companyId: "workspace",
        budgetId: "old-account-limit",
      });
      click(tree, "Authorize new allocation");
      expect(field(render(), "Account window").props.value).toBe(
        reading === "changed" ? windowKey("work") : "",
      );
    },
  );
  it("requires an explicit account choice if the settings provider has no reading", () => {
    state.snapshots = [snapshot("personal", "personal-account")];
    click(render(), "Set allowance");
    const tree = render();
    expect(field(tree, "Account window").props.value).toBe("");
    expect(
      visitElements(tree, (element) => element.props.children === "Add account window")?.props
        .disabled,
    ).toBe(true);
  });
  it.each(["new", "renew"])(
    "saves primary and fallback account windows together for a %s allocation",
    async (mode) => {
      if (mode === "renew") state.budgets = [budget("existing", "work-account")];
      click(render(), mode === "new" ? "Set allowance" : "Authorize new allocation");
      change(render(), "Allowance in percentage points", "10");
      click(render(), "Add account window");
      change(render(), "Account window", windowKey("cursor"));
      click(render(), "Add account window");
      change(render(), "Environment", "laptop");
      change(render(), "Account window", windowKey("remote-work"));
      click(render(), "Add account window");
      let markSent!: () => void;
      const sent = new Promise<void>((resolve) => {
        markSent = resolve;
      });
      state.request.mockImplementationOnce(() => {
        markSent();
        return Promise.resolve();
      });
      click(render(), "Authorize allocation");
      await sent;
      expect(state.request).toHaveBeenCalledWith(
        mode === "new" ? "providerAllowanceBudgets:create" : "providerAllowanceBudgets:resume",
        expect.objectContaining({
          companyId: "workspace",
          allocations: ["work", "cursor", "remote-work"].map((id) =>
            expect.objectContaining({
              snapshot: expect.objectContaining({ instanceId: id }),
              authorizedPercent: 10,
            }),
          ),
        }),
      );
      expect(state.refresh.mock.calls.map(([args]) => args.environmentId)).toEqual([
        "studio",
        "studio",
        "laptop",
      ]);
    },
  );
});
