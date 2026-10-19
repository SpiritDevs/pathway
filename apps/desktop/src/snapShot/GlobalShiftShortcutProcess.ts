// @effect-diagnostics globalTimers:off -- The child-process deadlines run at worker callback boundaries outside any Effect fiber.
// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only helper owns a Node child process for global shortcut capture.

import * as NodeChildProcess from "node:child_process";

import type { SnapShotModifier } from "@spiritdevs/contracts";

const START_TIMEOUT_MS = 5_000;

export function startGlobalShiftShortcutProcess(
  workerPath: string,
  modifier: SnapShotModifier,
  onTrigger: () => void,
  onFailure: (error: Error) => void,
): Promise<() => void> {
  const worker = NodeChildProcess.fork(workerPath, [modifier], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    execArgv: [],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let stopped = false;
    let exited = false;
    let startTimeout: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
    const clearStartTimeout = () => {
      if (!startTimeout) return;
      clearTimeout(startTimeout);
      startTimeout = undefined;
    };
    const clearForceKillTimeout = () => {
      if (!forceKillTimeout) return;
      clearTimeout(forceKillTimeout);
      forceKillTimeout = undefined;
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearStartTimeout();
      if (exited) return;
      worker.kill();
      forceKillTimeout = setTimeout(() => worker.kill("SIGKILL"), 1_000);
      forceKillTimeout.unref?.();
    };
    const fail = (error: Error) => {
      if (stopped) return;
      if (settled) {
        stop();
        onFailure(error);
        return;
      }
      settled = true;
      stop();
      reject(error);
    };
    startTimeout = setTimeout(
      () => fail(new Error("Snapshot shortcut helper timed out while starting.")),
      START_TIMEOUT_MS,
    );
    startTimeout.unref?.();

    worker.on("message", (message) => {
      if (message === "ready" && !settled) {
        settled = true;
        clearStartTimeout();
        resolve(stop);
        return;
      }
      if (message !== "trigger" || !settled || stopped) return;
      try {
        onTrigger();
      } catch {}
    });
    worker.once("error", (error) => {
      fail(error);
    });
    worker.once("exit", (code) => {
      exited = true;
      clearForceKillTimeout();
      fail(new Error(`Snapshot shortcut helper exited with code ${code}`));
    });
  });
}
