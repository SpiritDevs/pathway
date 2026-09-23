import { RegistryContext } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
} from "@spiritdevs/client-runtime/state/runtime";
import {
  COMPUTER_WS_METHODS,
  type ComputerInputPause,
  type ComputerWindow,
  type EnvironmentId,
} from "@spiritdevs/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useContext, useState } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { Button } from "../ui/button";

/** A readiness probe on the environment that owns the paused window. */
const computerReadinessProbe = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:computer:get-state",
  tag: COMPUTER_WS_METHODS.getState,
});

/** Readiness is an observation. It never raises a window or replays an action. */
export function ComputerInputPauseNotice({
  environmentId,
  pause,
  windows,
}: {
  environmentId: EnvironmentId;
  pause: ComputerInputPause;
  windows: readonly ComputerWindow[];
}) {
  const registry = useContext(RegistryContext);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const window = windows.find((item) => item.id === pause.windowId);
  const target = window?.appName ?? window?.title ?? "the target window";
  const check = async () => {
    if (!pause.windowId || checking) return;
    setChecking(true);
    setError(null);
    try {
      const result = await runAtomCommand(
        registry,
        computerReadinessProbe,
        { environmentId, input: { windowId: pause.windowId, includeScreenshot: false } },
        { reportFailure: false },
      );
      if (!AsyncResult.isSuccess(result)) {
        setError("Could not check the window. Try again after returning to it.");
      } else if (result.value.inputPause) {
        setError(
          "The window is still unavailable for input. Restore it on this desktop, then check again.",
        );
      }
    } catch {
      setError("Could not check the window. Try again after returning to it.");
    } finally {
      setChecking(false);
    }
  };
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-3 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium">Input paused — return to {target}</p>
        <p className="text-xs text-muted-foreground">
          {error ??
            "Bring the window onto this desktop, or exit the full-screen app, then check again. Continue from the current page once input is available."}
        </p>
      </div>
      {pause.windowId ? (
        <Button variant="outline" size="xs" disabled={checking} onClick={check}>
          {checking ? "Checking…" : "Check again"}
        </Button>
      ) : null}
    </div>
  );
}
