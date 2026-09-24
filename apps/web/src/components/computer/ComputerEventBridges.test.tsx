// The app root opens a computer event pipe only for environments whose server
// platform has a computer backend. The server configs are stubbed per
// environment; the pipe hooks are spies.

import { EnvironmentId } from "@spiritdevs/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

const MAC = EnvironmentId.make("environment-mac");
const WINDOWS = EnvironmentId.make("environment-windows");
const PENDING = EnvironmentId.make("environment-pending");

const hooks = vi.hoisted(() => ({
  platforms: {} as Record<string, string | undefined>,
  useComputerEnvironmentEvents: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (environmentId: string) => {
    const os = hooks.platforms[environmentId];
    return os === undefined ? null : { environment: { platform: { os } } };
  },
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: (environmentId: string) => environmentId },
}));
vi.mock("~/hooks/useComputerEventBridge", () => ({
  useComputerEnvironmentEvents: hooks.useComputerEnvironmentEvents,
  useComputerEventBridge: () => undefined,
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    environments: [MAC, WINDOWS, PENDING].map((environmentId) => ({ environmentId })),
  }),
}));

const { ComputerEventBridges } = await import("./ComputerEventBridges");

it("subscribes to Computer events only where the server could drive a desktop", () => {
  hooks.platforms = { [MAC]: "darwin", [WINDOWS]: "win32" };
  renderToStaticMarkup(<ComputerEventBridges />);
  expect(hooks.useComputerEnvironmentEvents.mock.calls).toEqual([[MAC]]);
});
