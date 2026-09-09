// @effect-diagnostics globalTimers:off -- The child-process deadlines run at native process callback boundaries outside any Effect fiber.
// @effect-diagnostics nodeBuiltinImport:off -- This macOS platform boundary spawns the native modifier-key poller with Node.

import * as NodeChildProcess from "node:child_process";

import type { SnapShotModifier } from "@spiritdevs/contracts";

const START_TIMEOUT_MS = 5_000;

const MAC_MODIFIER_PAIR_DEVICE_MASKS: Record<SnapShotModifier, readonly [number, number]> = {
  shift: [0x2, 0x4],
  control: [0x1, 0x2000],
  alt: [0x20, 0x40],
  meta: [0x8, 0x10],
};

const POLLER_SCRIPT = `
ObjC.import("CoreGraphics");
ObjC.import("unistd");
function run(argv) {
  const left = Number(argv[0]);
  const right = Number(argv[1]);
  const both = left | right;
  let active = false;
  console.log("ready");
  while ($.getppid() !== 1) {
    const pressed = ($.CGEventSourceFlagsState(0) & both) === both;
    if (pressed && !active) console.log("trigger");
    active = pressed;
    delay(0.05);
  }
  return "orphaned";
}`;

export function startMacModifierPairShortcutProcess(
  modifier: SnapShotModifier,
  onTrigger: () => void,
  onFailure: (error: Error) => void,
): Promise<() => void> {
  const [left, right] = MAC_MODIFIER_PAIR_DEVICE_MASKS[modifier];
  const poller = NodeChildProcess.spawn(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", POLLER_SCRIPT, String(left), String(right)],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let stopped = false;
    let exited = false;
    let buffered = "";
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
      poller.kill();
      forceKillTimeout = setTimeout(() => poller.kill("SIGKILL"), 1_000);
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

    poller.stderr.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const message = line.trim();
        if (message === "ready" && !settled) {
          settled = true;
          clearStartTimeout();
          resolve(stop);
          continue;
        }
        if (message !== "trigger" || !settled || stopped) continue;
        try {
          onTrigger();
        } catch {}
      }
    });
    poller.once("error", (error) => {
      fail(error);
    });
    poller.once("exit", (code) => {
      exited = true;
      clearForceKillTimeout();
      fail(new Error(`Snapshot shortcut helper exited with code ${code}`));
    });
  });
}
