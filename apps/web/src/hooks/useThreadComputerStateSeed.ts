import { RegistryContext } from "@effect/atom-react";
import { runAtomCommand } from "@spiritdevs/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@spiritdevs/contracts";
import { resolveComputerInvocationMode } from "@spiritdevs/shared/computerInvocation";
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

/**
 * The control generation a send's Computer intent is pinned to. A send right
 * after a reload or reconnect can beat the seed, so an unseeded server thread
 * asks the server rather than fall back to 0, which a stopped thread refuses.
 * Sends with no Computer intent, and threads the server has not seen yet, ask
 * nothing. Undefined when the server cannot answer.
 */
export async function readComputerControlGenerationForSend(
  registry: AtomRegistry.AtomRegistry,
  input: {
    /** The server thread the send lands on; null for a draft or a new chat. */
    readonly ref: ScopedThreadRef | null;
    readonly messageText: string;
    readonly computerControlEnabled: boolean;
    /** The seeded generation, or the one the draft recorded. */
    readonly known: number | undefined;
  },
): Promise<number | undefined> {
  if (input.known !== undefined || input.ref === null) return input.known;
  const mode = resolveComputerInvocationMode({
    messageText: input.messageText,
    enableComputerControl: input.computerControlEnabled,
  });
  if (mode === "off") return undefined;
  const ref = input.ref;
  const result = await runAtomCommand(
    registry,
    computerEnvironment.threadState,
    { environmentId: ref.environmentId, input: { threadId: ref.threadId } },
    { reportFailure: false },
  );
  if (!AsyncResult.isSuccess(result)) return undefined;
  useComputerStateStore.getState().upsertThreadState(ref.environmentId, result.value);
  return result.value.controlGeneration;
}

// Push events never carry a full snapshot, so the active chat seeds the store
// with one getThreadState on mount and re-seeds on every new connection
// generation, whether or not a preview is showing: a send needs the thread's
// control generation, and the preview needs the state to arm itself.
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
