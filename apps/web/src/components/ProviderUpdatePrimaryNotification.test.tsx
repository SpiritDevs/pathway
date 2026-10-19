import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@spiritdevs/contracts";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../test/reactElementTree";
import { reactHookHarness as hooks } from "../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  providers: Symbol("providers"),
  updateProvider: Symbol("updateProvider"),
}));

const testState = vi.hoisted(() => ({
  providers: [] as ReadonlyArray<ServerProvider>,
  dismissedKeys: new Set<string>(),
  dismiss: vi.fn(),
  navigate: vi.fn(),
  updateProvider: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => testState.providers,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => testState.navigate,
}));

vi.mock("../providerUpdateDismissal", () => ({
  useDismissedProviderUpdateNotificationKeys: () => ({
    dismissedNotificationKeys: testState.dismissedKeys,
    dismissNotificationKey: testState.dismiss,
  }),
}));

vi.mock("../state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId: EnvironmentId.make("primary") }),
}));

vi.mock("../state/server", () => ({
  primaryServerProvidersAtom: atoms.providers,
  serverEnvironment: { updateProvider: atoms.updateProvider },
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => testState.updateProvider,
}));

import { ProviderUpdatePrimaryNotification } from "./ProviderUpdatePrimaryNotification";

function provider(updateState?: ServerProvider["updateState"]): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-28T08:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "current",
      currentVersion: "1.0.0",
      latestVersion: null,
      updateCommand: null,
      canUpdate: false,
      checkedAt: "2026-08-28T08:00:00.000Z",
      message: "Provider is current.",
    },
    ...(updateState ? { updateState } : {}),
  };
}

function renderNotification(): ReactElement<Record<string, unknown>> | null {
  hooks.beginRender();
  return ProviderUpdatePrimaryNotification() as ReactElement<Record<string, unknown>> | null;
}

describe("ProviderUpdatePrimaryNotification", () => {
  beforeEach(() => {
    hooks.reset();
    testState.providers = [];
    testState.dismissedKeys = new Set();
    testState.dismiss.mockReset();
    testState.navigate.mockReset();
    testState.updateProvider.mockReset();
  });

  it("shows projected progress for an update started outside this title bar", () => {
    testState.dismissedKeys = new Set(["codex:1.1.0"]);
    testState.providers = [
      provider({
        status: "running",
        startedAt: "2026-08-28T08:00:00.000Z",
        finishedAt: null,
        message: "Updating provider.",
        output: null,
      }),
    ];

    const notification = renderNotification();

    expect(notification).not.toBeNull();
    expect(
      visitElements(notification, (element) => element.props.children === "Updating Codex"),
    ).not.toBeNull();
    expect(
      visitElements(
        notification,
        (element) =>
          typeof element.props.className === "string" &&
          element.props.className.includes("animate-spin"),
      ),
    ).not.toBeNull();
    expect(
      visitElements(
        notification,
        (element) => element.props["aria-label"] === "Dismiss provider update notice",
      ),
    ).toBeNull();
  });

  it("stays hidden for an idle provider without an available update", () => {
    testState.providers = [provider()];

    expect(renderNotification()).toBeNull();
  });
});
