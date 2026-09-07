import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EnvironmentId } from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  updateServer: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn() }),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { updateServer: Symbol("updateServer") },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.updateServer,
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: testState.toast },
}));

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "~/confirmDialog";

import {
  ServerUpdateAction,
  ServerUpdateProgress,
  serverUpdateStageLabel,
} from "./ServerUpdateAction";

type ActionElement = ReactElement<{
  readonly onClick?: () => void;
}>;

function renderAction(): ActionElement {
  return ServerUpdateAction({
    environmentId: "env-test" as EnvironmentId,
    serverLabel: "Test server",
    selfUpdate: "boot-service",
    targetVersion: "0.0.31",
  }) as ActionElement;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ServerUpdateAction", () => {
  beforeEach(() => {
    testState.updateServer.mockReset();
    testState.toast.mockReset();
    resetConfirmDialogForTests();
  });

  it("reports success only after the shared update flow reconnects", async () => {
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );

    renderAction().props.onClick?.();
    await flushPromises();

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31" },
    });
    expect(testState.toast).toHaveBeenCalledWith({
      type: "success",
      title: "Test server updated",
      description: "Reconnected on @spiritdevs/pathway@0.0.31.",
    });
  });

  it("reports one result when the update action is double-clicked", async () => {
    let finishUpdate: (() => void) | undefined;
    testState.updateServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishUpdate = () =>
            resolve(
              AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
            );
        }),
    );

    const action = renderAction();
    action.props.onClick?.();
    action.props.onClick?.();

    expect(testState.updateServer).toHaveBeenCalledTimes(1);
    finishUpdate?.();
    await flushPromises();
    expect(testState.toast).toHaveBeenCalledTimes(1);
  });

  it("quietly releases the action when the operation is interrupted", async () => {
    testState.updateServer.mockResolvedValue(AsyncResult.failure(Cause.interrupt()));

    renderAction().props.onClick?.();
    await flushPromises();

    expect(testState.toast).not.toHaveBeenCalled();
  });

  it("shares one restart confirmation across clicks and releases a cancelled update", async () => {
    const unregister = registerConfirmDialogHost();
    const action = ServerUpdateAction({
      environmentId: "env-test" as EnvironmentId,
      serverLabel: "Test server",
      selfUpdate: "desktop-managed",
      desktopAppUpdate: true,
      targetVersion: "0.0.31",
    }) as ActionElement;
    action.props.onClick?.();
    action.props.onClick?.();
    expect(readConfirmDialogState().status).toBe("confirming");
    expect(testState.updateServer).not.toHaveBeenCalled();
    respondToConfirmDialog(false);
    completeConfirmDialogClose();
    await flushPromises();
    expect(readConfirmDialogState().status).toBe("idle");
    expect(testState.updateServer).not.toHaveBeenCalled();

    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.34", method: "desktop-app" as const }),
    );
    action.props.onClick?.();
    respondToConfirmDialog(true);
    completeConfirmDialogClose();
    await flushPromises();
    expect(testState.updateServer).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("reports an update failure and releases the action for retry", async () => {
    testState.updateServer.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("The install was refused."))),
    );
    renderAction().props.onClick?.();
    await flushPromises();
    expect(testState.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Server update failed",
      description: "The install was refused.",
    });
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.31", method: "boot-service" as const }),
    );
    renderAction().props.onClick?.();
    await flushPromises();
    expect(testState.updateServer).toHaveBeenCalledTimes(2);
  });

  it("keeps the manual instruction for desktop servers without remote update support", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateAction
        environmentId={"env-test" as EnvironmentId}
        serverLabel="Test server"
        selfUpdate="desktop-managed"
        targetVersion="0.0.31"
      />,
    );

    expect(markup).toContain("Update the desktop app on that machine to update this server.");
    expect(markup).not.toContain("<button");
  });

  it("updates remote desktop apps through the shared update flow", async () => {
    testState.updateServer.mockResolvedValue(
      AsyncResult.success({ targetVersion: "0.0.34", method: "desktop-app" as const }),
    );

    const action = ServerUpdateAction({
      environmentId: "env-test" as EnvironmentId,
      serverLabel: "Test server",
      selfUpdate: "desktop-managed",
      desktopAppUpdate: true,
      targetVersion: "0.0.31",
    }) as ActionElement;

    // No confirm-dialog host is mounted in this test, which the component
    // treats as consent: the click itself was the request.
    action.props.onClick?.();
    await flushPromises();

    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      input: { targetVersion: "0.0.31" },
    });
    expect(testState.toast).toHaveBeenCalledWith({
      type: "success",
      title: "Test server updated",
      description: "Desktop app relaunched on 0.0.34.",
    });
  });
});

describe("ServerUpdateProgress", () => {
  it("describes every stage in the update bar", () => {
    expect(serverUpdateStageLabel("checking")).toBe("Checking for updates…");
    expect(serverUpdateStageLabel("downloading")).toBe("Downloading update…");
    expect(serverUpdateStageLabel("installing")).toBe("Installing update…");
    expect(serverUpdateStageLabel("resuming")).toBe("Reconnecting…");
  });

  it("shows one calm status row for the restart wait", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateProgress
        state={{
          status: "running",
          stage: "resuming",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
        }}
      />,
    );

    expect(markup).toContain("Reconnecting…");
    expect(markup).not.toContain("0.0.30");
    expect(markup).not.toContain("Resum");
    expect(markup).not.toContain("text-success");
    expect(markup).not.toContain("text-primary");
    expect(markup).toContain("animate-spin");
    expect(markup).toContain("motion-reduce:animate-none");
    expect(markup).toContain('role="status"');
  });

  it("shows the installing stage distinctly from downloading", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateProgress
        state={{
          status: "running",
          stage: "installing",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
        }}
      />,
    );

    expect(markup).toContain("Installing update…");
    expect(markup).not.toContain("Downloading");
  });

  it("keeps the failure visible with its retryable error", () => {
    const markup = renderToStaticMarkup(
      <ServerUpdateProgress
        state={{
          status: "failed",
          stage: "installing",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
          message: "The package could not be verified.",
        }}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("The package could not be verified.");
    expect(markup).not.toContain("animate-status-pulse");
  });
});
