import { RegistryContext } from "@effect/atom-react";
import { runAtomCommand } from "@spiritdevs/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@spiritdevs/contracts";
import { AsyncResult, type AtomRegistry } from "effect/unstable/reactivity";
import { useContext, useEffect } from "react";

import { computerEnvironment } from "~/state/computer";
import { useComputerStateStore } from "../computerStateStore";
import { useConnectedGeneration } from "./useComputerEventBridge";

/**
 * Ask for one thread's computer state and store it. Asking is load-bearing:
 * the server only pushes `computer.thread-state` for threads a socket has
 * watched, and `getThreadState` is what registers that interest.
 */
export function seedThreadComputerState(
  registry: AtomRegistry.AtomRegistry,
  ref: ScopedThreadRef,
  isCurrent: () => boolean,
): void {
  void runAtomCommand(
    registry,
    computerEnvironment.threadState,
    { environmentId: ref.environmentId, input: { threadId: ref.threadId } },
    // The state push or the next reconnect seed can still provide a usable
    // availability result after a transient RPC failure.
    { reportFailure: false },
  ).then((result) => {
    if (isCurrent() && AsyncResult.isSuccess(result)) {
      useComputerStateStore.getState().upsertThreadState(ref.environmentId, result.value);
    }
  });
}

// Push events never carry a full snapshot, so every surface that renders
// computer availability (the ambient preview and the composer's
// computer-control toggle) seeds the store with one getThreadState on mount
// and re-seeds on every new connection generation.
export function useThreadComputerStateSeed(ref: ScopedThreadRef | null): void {
  const registry = useContext(RegistryContext);
  const environmentId = ref?.environmentId ?? null;
  const threadId = ref?.threadId ?? null;
  const generation = useConnectedGeneration(environmentId);

  useEffect(() => {
    if (environmentId === null || threadId === null || generation === null) return;
    let cancelled = false;
    seedThreadComputerState(registry, { environmentId, threadId }, () => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [environmentId, threadId, generation, registry]);
}
