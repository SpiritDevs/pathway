import * as Cause from "effect/Cause";
import type { ReactElement } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
} from "@spiritdevs/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  providers: null as ReadonlyArray<ServerProvider> | null,
  providersAtom: Symbol("providers"),
  refreshProviders: Symbol("refreshProviders"),
  updateProvider: Symbol("updateProvider"),
}));

const commands = vi.hoisted(() => ({
  refresh: vi.fn(),
  updateProvider: vi.fn(),
}));

const toasts = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("../ui/toast", () => ({
  toastManager: toasts,
  stackedThreadToast: (value: unknown) => value,
}));

const settingsState = vi.hoisted(() => ({
  value: null as UnifiedSettings | null,
  readEnvironmentIds: [] as EnvironmentId[],
  updateEnvironmentIds: [] as EnvironmentId[],
  updateSettings: vi.fn(),
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
  useAtomValue: () => atoms.providers,
}));

vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    providersValueAtom: () => atoms.providersAtom,
    refreshProviders: atoms.refreshProviders,
    updateProvider: atoms.updateProvider,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) =>
    atom === atoms.refreshProviders ? commands.refresh : commands.updateProvider,
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (environmentId: EnvironmentId) => {
    settingsState.readEnvironmentIds.push(environmentId);
    return settingsState.value;
  },
  useUpdateEnvironmentSettings: (environmentId: EnvironmentId) => {
    settingsState.updateEnvironmentIds.push(environmentId);
    return settingsState.updateSettings;
  },
}));

vi.mock("../../environments/primary", () => ({
  usePrimarySessionState: () => ({ data: null, error: null, isPending: false, refresh: vi.fn() }),
}));

vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({ data: null, hasError: false, isPending: true }),
}));

import { EnvironmentProviderSettings } from "./ProviderSettingsPanel";

const environmentId = EnvironmentId.make("remote-device");
const codexId = ProviderInstanceId.make("codex");
const customId = ProviderInstanceId.make("codex_work");

function provider(): ServerProvider {
  return {
    instanceId: codexId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-24T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "pnpm add -g @openai/codex@latest",
      canUpdate: true,
      checkedAt: "2026-07-24T12:00:00.000Z",
      message: "Update available.",
    },
  };
}

function renderPanel(options?: {
  readonly readOnly?: boolean;
}): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return EnvironmentProviderSettings({
    environmentId,
    environmentLabel: "Remote device",
    ...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  }) as ReactElement<Record<string, unknown>>;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("EnvironmentProviderSettings routing", () => {
  beforeEach(() => {
    hooks.reset();
    toasts.add.mockReset();
    atoms.providers = null;
    settingsState.value = DEFAULT_UNIFIED_SETTINGS;
    settingsState.readEnvironmentIds = [];
    settingsState.updateEnvironmentIds = [];
    settingsState.updateSettings.mockReset();
    commands.refresh.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.updateProvider.mockReset().mockResolvedValue({ _tag: "Success" });
  });

  it("coalesces a nullable provider snapshot before rendering array-backed UI", () => {
    expect(() => renderPanel()).not.toThrow();
    expect(settingsState.readEnvironmentIds).toEqual([environmentId]);
    expect(settingsState.updateEnvironmentIds).toEqual([environmentId]);
  });

  it("routes refresh and provider update commands to the selected environment", async () => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    const refreshButton = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Refresh provider status",
    );
    expect(refreshButton).not.toBeNull();
    (refreshButton?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.refresh).toHaveBeenCalledWith({ environmentId, input: {} });

    const providerCard = visitElements(
      panel,
      (element) =>
        element.props.instanceId === codexId && typeof element.props.onRunUpdate === "function",
    );
    expect(providerCard).not.toBeNull();
    (providerCard?.props.onRunUpdate as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.updateProvider).toHaveBeenCalledWith({
      environmentId,
      input: { provider: ProviderDriverKind.make("codex"), instanceId: codexId },
    });
  });

  it("forces model downloads on the selected environment and confirms completion", async () => {
    commands.refresh.mockResolvedValue({
      _tag: "Success",
      value: { providers: [], modelCatalogUpdatedAt: "2026-09-23T00:00:00Z" },
    });
    const button = visitElements(
      renderPanel(),
      (element) => element.props["aria-label"] === "Update model catalog",
    );
    expect(button).not.toBeNull();
    (button?.props.onClick as (() => void) | undefined)?.();
    (button?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();
    expect(commands.refresh).toHaveBeenCalledTimes(1);
    expect(commands.refresh).toHaveBeenCalledWith({
      environmentId,
      input: { forceModelCatalogRefresh: true },
    });
    expect(toasts.add).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Model catalog updated" }),
    );
  });

  it("does not claim a model download succeeded on older servers", async () => {
    commands.refresh.mockResolvedValue({ _tag: "Success", value: { providers: [] } });
    const button = visitElements(
      renderPanel(),
      (element) => element.props["aria-label"] === "Update model catalog",
    );
    (button?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();
    expect(toasts.add).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Pathway update required" }),
    );
  });

  it("reports catalog download errors and releases the refresh guard for retry", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    commands.refresh.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("Download unavailable")),
    });
    const button = visitElements(
      renderPanel(),
      (element) => element.props["aria-label"] === "Update model catalog",
    );
    (button?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();
    expect(toasts.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Could not update model catalog",
        description: "Download unavailable",
      }),
    );
    (button?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();
    expect(commands.refresh).toHaveBeenCalledTimes(2);
    warning.mockRestore();
  });

  it("disables model catalog downloads for read-only connections", () => {
    const button = visitElements(
      renderPanel({ readOnly: true }),
      (element) => element.props["aria-label"] === "Update model catalog",
    );
    expect(button?.props.disabled).toBe(true);
  });

  it("attaches allowance management to each supported provider instance in its environment", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codexId]: { driver: ProviderDriverKind.make("codex"), displayName: "Personal" },
        [customId]: { driver: ProviderDriverKind.make("codex"), displayName: "Work" },
      },
    };
    const panel = renderPanel();
    for (const [instanceId, displayName] of [
      [codexId, "Personal"],
      [customId, "Work"],
    ] as const) {
      const card = visitElements(
        panel,
        (element) => element.props.instanceId === instanceId && "allowanceAction" in element.props,
      );
      const action = card?.props.allowanceAction as ReactElement<Record<string, unknown>>;
      expect(action.props).toMatchObject({
        environmentId,
        instanceId,
        provider: "codex",
        displayName,
      });
    }
    const unsupported = visitElements(
      panel,
      (element) => element.props.instanceId === "grok" && "allowanceAction" in element.props,
    );
    expect(unsupported?.props.allowanceAction).toBeUndefined();
  });

  it("renders the provider layout inert with a limited-permissions notice when read only", () => {
    atoms.providers = [provider()];
    const panel = renderPanel({ readOnly: true });

    const inertWrapper = visitElements(panel, (element) => element.props.inert === true);
    expect(inertWrapper).not.toBeNull();
    const providerCard = visitElements(panel, (element) => element.props.instanceId === codexId);
    expect(providerCard).not.toBeNull();
    expect(providerCard?.props.allowanceAction).toBeUndefined();
    const isAllowance = (element: ReactElement<Record<string, unknown>>) =>
      element.props.environmentId === environmentId &&
      element.props.instanceId === codexId &&
      element.props.provider === "codex";
    expect(visitElements(inertWrapper, isAllowance)).toBeNull();
    expect(visitElements(panel, isAllowance)).not.toBeNull();

    const notice = visitElements(panel, (element) => element.props.title === "Limited permissions");
    expect(notice).not.toBeNull();

    expect(
      visitElements(panel, (element) => element.props["aria-label"] === "Add provider instance"),
    ).toBeNull();
    expect(
      visitElements(panel, (element) => element.props["aria-label"] === "Refresh provider status"),
    ).toBeNull();
  });

  it("keeps the editable layout interactive when not read only", () => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    expect(visitElements(panel, (element) => element.props.inert === true)).toBeNull();
    expect(
      visitElements(panel, (element) => element.props.title === "Limited permissions"),
    ).toBeNull();
  });

  it("deletes and resets provider configuration without erasing shared preferences", () => {
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
        },
        [customId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
      providerModelPreferences: {
        [customId]: { hiddenModels: ["hidden"], modelOrder: ["model"] },
      },
      favorites: [{ provider: customId, model: "favorite" }],
    };
    const panel = renderPanel();
    const customCard = visitElements(panel, (element) => element.props.instanceId === customId);
    expect(customCard).not.toBeNull();
    (customCard?.props.onDelete as (() => void) | undefined)?.();

    expect(settingsState.updateSettings).toHaveBeenLastCalledWith({
      providerInstances: {
        [codexId]: settingsState.value.providerInstances?.[codexId],
      },
    });

    settingsState.updateSettings.mockClear();
    const defaultCard = visitElements(panel, (element) => element.props.instanceId === codexId);
    const resetAction = defaultCard?.props.headerAction;
    const resetButton = visitElements(
      resetAction,
      (element) => typeof element.props.onClick === "function",
    );
    expect(resetButton).not.toBeNull();
    (resetButton?.props.onClick as (() => void) | undefined)?.();

    const resetPatch = settingsState.updateSettings.mock.lastCall?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(Object.keys(resetPatch ?? {}).sort()).toEqual(["providerInstances", "providers"]);
    expect(resetPatch).not.toHaveProperty("favorites");
    expect(resetPatch).not.toHaveProperty("providerModelPreferences");
  });
});
