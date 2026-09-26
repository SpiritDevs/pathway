import { EnvironmentId } from "@spiritdevs/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const probe = vi.hoisted(() => ({
  getState: vi.fn(),
  click: undefined as undefined | (() => Promise<void>),
}));
vi.mock("@spiritdevs/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@spiritdevs/client-runtime/state/runtime")>()),
  runAtomCommand: (_registry: unknown, _command: unknown, input: unknown) => probe.getState(input),
}));
vi.mock("../ui/button", () => ({
  Button: (props: ComponentProps<"button">) => {
    probe.click = props.onClick as unknown as () => Promise<void>;
    return <button>{props.children}</button>;
  },
}));

import { ComputerInputPauseNotice } from "./ComputerInputPauseNotice";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const WINDOW_ID = "1357";

beforeEach(() => {
  probe.getState.mockReset();
  probe.click = undefined;
});

it.each([{}, { inputPause: { windowId: WINDOW_ID, message: "Still paused" } }])(
  "checks readiness without capturing pixels or replaying input",
  async (result) => {
    probe.getState.mockResolvedValue(AsyncResult.success(result));
    renderToStaticMarkup(
      <ComputerInputPauseNotice
        environmentId={ENVIRONMENT_ID}
        pause={{ windowId: WINDOW_ID, message: "Paused" }}
        windows={[]}
      />,
    );
    await probe.click!();
    expect(probe.getState).toHaveBeenCalledExactlyOnceWith({
      environmentId: ENVIRONMENT_ID,
      input: { windowId: WINDOW_ID, includeScreenshot: false },
    });
  },
);

it("handles a failed readiness request without retrying", async () => {
  probe.getState.mockRejectedValue(new Error("Disconnected"));
  renderToStaticMarkup(
    <ComputerInputPauseNotice
      environmentId={ENVIRONMENT_ID}
      pause={{ windowId: WINDOW_ID, message: "Paused" }}
      windows={[]}
    />,
  );
  await expect(probe.click!()).resolves.toBeUndefined();
  expect(probe.getState).toHaveBeenCalledTimes(1);
});
