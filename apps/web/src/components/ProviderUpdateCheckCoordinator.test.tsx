import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@spiritdevs/contracts";
import { reactHookHarness as hooks } from "../test/reactHookHarness";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  environments: [] as { environmentId: EnvironmentId; connection: { phase: string } }[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { ...actual, useCallback: reactHookHarness.useCallback };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: mocks.environments }),
}));
vi.mock("../state/server", () => ({ serverEnvironment: { refreshProviders: Symbol("refresh") } }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => mocks.refresh }));
vi.mock("../panes/windowMode", () => ({ isChildWindow: false }));

import { useCheckProviderUpdates } from "./ProviderUpdateCheckCoordinator";

describe("provider update checks", () => {
  beforeEach(() => {
    hooks.reset();
    mocks.refresh.mockReset().mockResolvedValue({ _tag: "Success" });
    mocks.environments = [];
  });

  it("checks connected primary, WSL and relay environments while skipping disconnected ones", async () => {
    const ids = ["primary", "wsl", "relay", "offline"].map((id) => EnvironmentId.make(id));
    mocks.environments = ids.map((environmentId, index) => ({
      environmentId,
      connection: { phase: index === 3 ? "offline" : "connected" },
    }));
    hooks.beginRender();
    expect(await useCheckProviderUpdates()()).toEqual({ checked: 3, failed: 0 });
    expect(mocks.refresh.mock.calls.map(([input]) => input)).toEqual(
      ids.slice(0, 3).map((environmentId) => ({ environmentId, input: {} })),
    );
  });

  it("checks the remaining environments when one denies update access", async () => {
    mocks.environments = ["restricted", "allowed"].map((id) => ({
      environmentId: EnvironmentId.make(id),
      connection: { phase: "connected" },
    }));
    mocks.refresh.mockResolvedValueOnce({ _tag: "Failure" });
    hooks.beginRender();
    expect(await useCheckProviderUpdates()()).toEqual({ checked: 1, failed: 1 });
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });
});
