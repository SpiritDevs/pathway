import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";
import { threadListReadinessAtom } from "../state/threadListReadiness";
import { environmentShellSummaryAtom } from "../state/shell";
import { recordShellStartupMilestone } from "./clientTracing";

export function ShellStartupTrace() {
  const readiness = useAtomValue(threadListReadinessAtom);
  const shell = useAtomValue(environmentShellSummaryAtom);
  useEffect(() => {
    if (readiness !== "ready" || !shell.hasSnapshot) return;
    // A live environment alongside a cached one is still a cached shell.
    const kind =
      shell.hasCachedShell || shell.hasSynchronizingShell
        ? "cachedShellPainted"
        : shell.hasLiveShell
          ? "liveShellSynced"
          : null;
    if (kind === null) return;
    let secondFrame: number | undefined;
    const firstFrame = requestAnimationFrame(() => {
      // The second frame follows the committed shell's first paint.
      secondFrame = requestAnimationFrame(() => recordShellStartupMilestone(kind));
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
    };
  }, [
    readiness,
    shell.hasSnapshot,
    shell.hasCachedShell,
    shell.hasSynchronizingShell,
    shell.hasLiveShell,
  ]);
  return null;
}
