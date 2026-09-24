// The app root opens a computer event pipe only for environments whose server
// advertises Computer on a platform with a computer backend, and whose fetched
// status has not already said otherwise. The server configs and cached statuses
// are stubbed per environment; the pipe hooks are spies.

import { EnvironmentId, type ComputerStatusResult } from "@spiritdevs/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

const MAC = EnvironmentId.make("environment-mac");
const OLD_MAC = EnvironmentId.make("environment-old-mac");
const UNSUPPORTED_LINUX = EnvironmentId.make("environment-unsupported-linux");
const WINDOWS = EnvironmentId.make("environment-windows");
const PENDING = EnvironmentId.make("environment-pending");

const hooks = vi.hoisted(() => ({
  servers: {} as Record<string, { os: string; computer: boolean } | undefined>,
  statuses: {} as Record<string, ComputerStatusResult | undefined>,
  useComputerEnvironmentEvents: vi.fn(),
  useComputerEnvironmentLifetime: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (environmentId: string) => {
    const server = hooks.servers[environmentId];
    return server === undefined
      ? null
      : {
          environment: {
            platform: { os: server.os },
            capabilities: server.computer ? { computerOperateScope: true } : {},
          },
        };
  },
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: (environmentId: string) => environmentId },
}));
vi.mock("~/computerStateStore", () => ({
  useCachedComputerStatus: (environmentId: string) => hooks.statuses[environmentId],
}));
vi.mock("~/hooks/useComputerEventBridge", () => ({
  useComputerEnvironmentEvents: hooks.useComputerEnvironmentEvents,
  useComputerEnvironmentLifetime: hooks.useComputerEnvironmentLifetime,
  useComputerEventBridge: () => undefined,
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    environments: [MAC, OLD_MAC, UNSUPPORTED_LINUX, WINDOWS, PENDING].map((environmentId) => ({
      environmentId,
    })),
  }),
}));

const { ComputerEventBridges } = await import("./ComputerEventBridges");

it("subscribes to Computer events only where the server is known to serve them", () => {
  hooks.servers = {
    [MAC]: { os: "darwin", computer: true },
    // A server from before Computer runs on a capable platform but has no events.
    [OLD_MAC]: { os: "darwin", computer: false },
    [UNSUPPORTED_LINUX]: { os: "linux", computer: true },
    [WINDOWS]: { os: "win32", computer: true },
  };
  hooks.statuses = {
    [UNSUPPORTED_LINUX]: {
      availability: { kind: "unsupported-platform", platform: "linux" },
    } as ComputerStatusResult,
  };
  renderToStaticMarkup(<ComputerEventBridges />);
  expect(hooks.useComputerEnvironmentEvents.mock.calls).toEqual([[MAC]]);
  // Every catalog environment's state outlives its pipe until it leaves.
  expect(hooks.useComputerEnvironmentLifetime.mock.calls).toEqual(
    [MAC, OLD_MAC, UNSUPPORTED_LINUX, WINDOWS, PENDING].map((environmentId) => [environmentId]),
  );
});
