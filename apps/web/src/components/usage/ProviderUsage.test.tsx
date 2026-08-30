import type { ReactElement } from "react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
  type ServerProviderUsageSnapshot,
} from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  providers: null as ReadonlyArray<ServerProvider> | null,
  providersAtom: Symbol("providers"),
  serverConfigs: new Map<EnvironmentId, ServerConfig>(),
  serverConfigsAtom: Symbol("serverConfigs"),
  refreshProviderUsage: Symbol("refreshProviderUsage"),
}));

const testState = vi.hoisted(() => ({
  queries: new Map<string, ServerProviderUsageSnapshot>(),
  pendingQueries: new Set<string>(),
  // The live subscription reports no data until its first emission arrives.
  listLoaded: true,
  refresh: vi.fn(),
  toast: vi.fn(),
  environments: [] as ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly connection: { readonly phase: "connected" | "offline" };
  }>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === atoms.serverConfigsAtom ? atoms.serverConfigs : atoms.providers,
}));

vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    isReady: true,
    environments: testState.environments,
  }),
}));

vi.mock("~/state/server", () => ({
  environmentServerConfigsAtom: atoms.serverConfigsAtom,
  serverEnvironment: {
    providersValueAtom: () => atoms.providersAtom,
    providerUsageLive: (target: unknown) => target,
    refreshProviderUsage: atoms.refreshProviderUsage,
  },
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (target: unknown) => ({
    data: target === null || !testState.listLoaded ? null : Array.from(testState.queries.values()),
    error: null,
    isPending: target !== null && testState.pendingQueries.size > 0,
    refresh: vi.fn(),
  }),
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.refresh,
}));

vi.mock("../ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: testState.toast },
}));

import {
  EnvironmentProviderUsage,
  EnvironmentProviderUsageList,
  ConnectedProviderUsageMenu,
  ProviderUsageSettingsSection,
} from "./ProviderUsage";

const environmentId = EnvironmentId.make("usage-environment");
const codexId = ProviderInstanceId.make("codex");
const claudeId = ProviderInstanceId.make("claudeAgent");

function provider(
  driver: "codex" | "claudeAgent",
  instanceId: ProviderInstanceId,
  options: { readonly displayName?: string; readonly email?: string } = {},
): ServerProvider {
  return {
    driver: ProviderDriverKind.make(driver),
    instanceId,
    displayName: options.displayName ?? (driver === "codex" ? "Codex" : "Claude"),
    enabled: true,
    installed: true,
    auth: {
      status: "authenticated",
      email: options.email ?? `${driver}@example.com`,
    },
  } as ServerProvider;
}

function setConnectedProviders(
  entries: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly providers: ReadonlyArray<ServerProvider>;
  }>,
) {
  testState.environments = entries.map(({ environmentId, label }) => ({
    environmentId,
    label,
    connection: { phase: "connected" as const },
  }));
  atoms.serverConfigs = new Map(
    entries.map(({ environmentId, providers }) => [environmentId, { providers } as ServerConfig]),
  );
}

function snapshot(
  instanceId: ProviderInstanceId,
  providerDriver: "codex" | "claudeAgent",
  usedPercent: number,
): ServerProviderUsageSnapshot {
  return {
    instanceId,
    provider: providerDriver,
    updatedAt: "2026-08-13T06:00:00.000Z",
    limits: [
      { window: "Session", usedPercent, resetsAt: "2026-08-13T07:00:00.000Z" },
      { window: "Weekly", usedPercent: Math.min(usedPercent + 10, 100) },
    ],
    usageLines: [{ label: "Plan", value: usedPercent < 50 ? "Pro" : "Team" }],
    source: "provider",
    status: "ok",
    planName: usedPercent < 50 ? "Pro" : "Team",
  };
}

function renderSingle(): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return EnvironmentProviderUsage({
    environmentId,
    provider: provider("codex", codexId),
    enabled: true,
    displayMode: "panel",
  }) as ReactElement<Record<string, unknown>>;
}

function renderList(): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return EnvironmentProviderUsageList({ environmentId, enabled: true }) as ReactElement<
    Record<string, unknown>
  >;
}

function findRefreshButton(tree: ReactElement<Record<string, unknown>>) {
  return visitElements(tree, (element) => element.props["aria-label"] === "Refresh usage");
}

function findSpinningRefreshIcon(tree: ReactElement<Record<string, unknown>>) {
  return visitElements(
    tree,
    (element) =>
      typeof element.props.className === "string" &&
      element.props.className.split(/\s+/).includes("animate-spin") &&
      element.props.className.split(/\s+/).includes("[animation-duration:2s]") &&
      element.props.className.split(/\s+/).includes("motion-reduce:animate-none"),
  );
}

function clickEvent() {
  return { preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("provider usage panel refresh", () => {
  beforeEach(() => {
    hooks.reset();
    atoms.providers = null;
    atoms.serverConfigs = new Map();
    testState.environments = [];
    testState.queries.clear();
    testState.pendingQueries.clear();
    testState.listLoaded = true;
    testState.refresh.mockReset();
    testState.toast.mockReset();
  });

  it("reveals an accessible, calm refresh action on hover or focus", () => {
    testState.queries.set(String(codexId), snapshot(codexId, "codex", 20));

    const panel = renderSingle();
    const button = findRefreshButton(panel);
    const tooltip = visitElements(
      panel,
      (element) => element.props.children === "Refresh usage" && element.props.side === "top",
    );

    expect(button?.props.className).toContain("opacity-0");
    expect(button?.props.className).toContain("group-hover/usage:opacity-100");
    expect(button?.props.className).toContain("group-focus-within/usage:opacity-100");
    expect(button?.props.className).toContain("focus-visible:opacity-100");
    expect(button?.props.className).toContain("motion-reduce:transition-none");
    expect(button?.props.className).not.toContain("animate-spin");
    expect(button?.props["aria-busy"]).toBe(false);
    expect(button?.props.disabled).toBe(false);
    expect(tooltip).not.toBeNull();
  });

  it("reveals and spins the refresh action while the first usage list loads", () => {
    testState.listLoaded = false;
    testState.pendingQueries.add(String(codexId));

    const panel = renderSingle();
    const button = findRefreshButton(panel);
    const pendingContent = visitElements(
      panel,
      (element) => element.props["data-provider-usage-pending"] === true,
    );
    const icon = visitElements(
      panel,
      (element) =>
        typeof element.props.className === "string" &&
        element.props.className.includes(
          "group-has-[[data-provider-usage-pending]]/usage:animate-spin",
        ),
    );

    expect(pendingContent).not.toBeNull();
    expect(pendingContent?.props["aria-busy"]).toBe(true);
    expect(button?.props.className).toContain(
      "group-has-[[data-provider-usage-pending]]/usage:opacity-100",
    );
    expect(icon?.props.className).toContain(
      "motion-reduce:group-has-[[data-provider-usage-pending]]/usage:animate-none",
    );
  });

  it("stops spinning once the live list arrives even though the stream stays open", () => {
    // The subscription never completes, so its underlying `waiting` flag stays
    // true forever; only the absence of data may present as loading.
    testState.pendingQueries.add(String(codexId));
    testState.queries.set(String(codexId), snapshot(codexId, "codex", 20));

    const panel = renderSingle();
    const pendingContent = visitElements(
      panel,
      (element) => element.props["data-provider-usage-pending"] === true,
    );

    expect(pendingContent).toBeNull();
  });

  it("forces one refresh, stays busy, preserves disclosure state, and reads the broadcast", async () => {
    const initial = snapshot(codexId, "codex", 20);
    const refreshed = snapshot(codexId, "codex", 70);
    testState.queries.set(String(codexId), initial);
    let finishRefresh: (() => void) | undefined;
    testState.refresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRefresh = () => {
            testState.queries.set(String(codexId), refreshed);
            resolve(AsyncResult.success(refreshed));
          };
        }),
    );

    const panel = renderSingle();
    const disclosure = visitElements(panel, (element) => element.props["aria-expanded"] === false);
    (disclosure?.props.onClick as (() => void) | undefined)?.();

    const refreshButton = findRefreshButton(panel);
    const event = clickEvent();
    const onClick = refreshButton?.props.onClick as
      | ((event: ReturnType<typeof clickEvent>) => void)
      | undefined;
    onClick?.(event);
    onClick?.(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(event.stopPropagation).toHaveBeenCalledTimes(2);
    expect(testState.refresh).toHaveBeenCalledTimes(1);
    expect(testState.refresh).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId: codexId, provider: "codex", forceRefresh: true },
    });

    const pendingPanel = renderSingle();
    expect(findRefreshButton(pendingPanel)?.props.disabled).toBe(true);
    expect(findRefreshButton(pendingPanel)?.props["aria-busy"]).toBe(true);
    expect(findSpinningRefreshIcon(pendingPanel)).not.toBeNull();
    expect(visitElements(pendingPanel, (element) => element.props.open === true)).not.toBeNull();
    expect(
      visitElements(pendingPanel, (element) => element.props.snapshot === initial),
    ).not.toBeNull();

    finishRefresh?.();
    await flushPromises();
    const updatedPanel = renderSingle();
    expect(findRefreshButton(updatedPanel)?.props.disabled).toBe(false);
    expect(findSpinningRefreshIcon(updatedPanel)).toBeNull();
    expect(
      visitElements(updatedPanel, (element) => element.props.snapshot === refreshed),
    ).not.toBeNull();
  });

  it("retains the last snapshot and reports a failed refresh", async () => {
    const initial = snapshot(codexId, "codex", 20);
    testState.queries.set(String(codexId), initial);
    testState.refresh.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Offline"))));

    const panel = renderSingle();
    const event = clickEvent();
    (
      findRefreshButton(panel)?.props.onClick as
        | ((event: ReturnType<typeof clickEvent>) => void)
        | undefined
    )?.(event);
    await flushPromises();

    const settledPanel = renderSingle();
    expect(
      visitElements(settledPanel, (element) => element.props.snapshot === initial),
    ).not.toBeNull();
    expect(testState.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Couldn’t refresh usage",
      description: "Offline",
    });
  });

  it("refreshes every displayed provider and reports partial failure", async () => {
    const codex = provider("codex", codexId);
    const claude = provider("claudeAgent", claudeId);
    atoms.providers = [codex, claude];
    testState.queries.set(String(codexId), snapshot(codexId, "codex", 20));
    testState.queries.set(String(claudeId), snapshot(claudeId, "claudeAgent", 30));
    const refreshedCodex = snapshot(codexId, "codex", 70);
    testState.refresh.mockImplementation(
      ({ input }: { readonly input: { readonly instanceId: ProviderInstanceId } }) =>
        input.instanceId === codexId
          ? Promise.resolve(AsyncResult.success(refreshedCodex))
          : Promise.resolve(AsyncResult.failure(Cause.fail(new Error("Claude unavailable")))),
    );

    const list = renderList();
    const event = clickEvent();
    (
      findRefreshButton(list)?.props.onClick as
        | ((event: ReturnType<typeof clickEvent>) => void)
        | undefined
    )?.(event);
    await flushPromises();

    expect(testState.refresh).toHaveBeenCalledTimes(2);
    expect(testState.refresh).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId: codexId, provider: "codex", forceRefresh: true },
    });
    expect(testState.refresh).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId: claudeId, provider: "claudeAgent", forceRefresh: true },
    });

    expect(testState.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Some usage couldn’t be refreshed",
      description: "Couldn’t refresh Claude.",
    });
  });

  it("spins the provider-settings refresh icon only while all usage refreshes are pending", async () => {
    setConnectedProviders([
      {
        environmentId,
        label: "Studio",
        providers: [provider("codex", codexId), provider("claudeAgent", claudeId)],
      },
    ]);
    let finishRefresh: (() => void) | undefined;
    testState.refresh.mockImplementation(
      ({ input }: { readonly input: { readonly instanceId: ProviderInstanceId } }) =>
        new Promise((resolve) => {
          const previousFinish = finishRefresh;
          finishRefresh = () => {
            previousFinish?.();
            resolve(
              AsyncResult.success(
                input.instanceId === codexId
                  ? snapshot(codexId, "codex", 40)
                  : snapshot(claudeId, "claudeAgent", 50),
              ),
            );
          };
        }),
    );

    hooks.beginRender();
    const settings = ProviderUsageSettingsSection() as ReactElement<Record<string, unknown>>;
    const button = visitElements(
      settings,
      (element) => element.props["aria-label"] === "Refresh provider usage",
    );
    (button?.props.onClick as (() => void) | undefined)?.();

    hooks.beginRender();
    const pendingSettings = ProviderUsageSettingsSection() as ReactElement<Record<string, unknown>>;
    const pendingButton = visitElements(
      pendingSettings,
      (element) => element.props["aria-label"] === "Refresh provider usage",
    );
    expect(pendingButton?.props.disabled).toBe(true);
    expect(pendingButton?.props["aria-busy"]).toBe(true);
    expect(findSpinningRefreshIcon(pendingSettings)).not.toBeNull();
    expect(testState.refresh).toHaveBeenCalledTimes(2);

    finishRefresh?.();
    await flushPromises();
    hooks.beginRender();
    const settledSettings = ProviderUsageSettingsSection() as ReactElement<Record<string, unknown>>;
    expect(findSpinningRefreshIcon(settledSettings)).toBeNull();
  });

  it("shows one row per provider account instead of grouping rows by environment", () => {
    const laptopId = EnvironmentId.make("usage-laptop");
    const laptopClaudeId = ProviderInstanceId.make("laptop-claude");
    const laptopCodexId = ProviderInstanceId.make("laptop-codex");
    const workCodexId = ProviderInstanceId.make("work");
    setConnectedProviders([
      {
        environmentId,
        label: "Studio",
        providers: [
          provider("claudeAgent", claudeId, { email: "corey@example.com" }),
          provider("codex", codexId, { email: "corey@openai.example" }),
          provider("codex", workCodexId, {
            displayName: "Work",
            email: "work@openai.example",
          }),
        ],
      },
      {
        environmentId: laptopId,
        label: "Laptop",
        providers: [
          provider("claudeAgent", laptopClaudeId, { email: "COREY@example.com" }),
          provider("codex", laptopCodexId, { email: "corey@openai.example" }),
        ],
      },
    ]);

    hooks.beginRender();
    const menu = ConnectedProviderUsageMenu() as ReactElement<Record<string, unknown>>;
    const rows: Array<ReactElement<Record<string, unknown>>> = [];
    visitElements(menu, (element) => {
      if (element.props.account) rows.push(element);
      return false;
    });

    expect(rows.map((row) => (row.props.account as { displayName: string }).displayName)).toEqual([
      "Claude",
      "Codex",
      "Work",
    ]);
    expect(visitElements(menu, (element) => element.props.children === "Studio")).toBeNull();
    expect(visitElements(menu, (element) => element.props.children === "Laptop")).toBeNull();
  });
});
