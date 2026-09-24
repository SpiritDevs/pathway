import { RegistryContext } from "@effect/atom-react";
import { scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import { isComputerThreadStateCurrent } from "@spiritdevs/client-runtime/state/computer-state";
import { runAtomCommand } from "@spiritdevs/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@spiritdevs/contracts";
import { resolveComputerInvocationMode } from "@spiritdevs/shared/computerInvocation";
import { AsyncResult, type AtomRegistry } from "effect/unstable/reactivity";
import { useContext, useEffect } from "react";

import { computerEnvironment } from "~/state/computer";
import { computerEnvironmentFence, useComputerStateStore } from "../computerStateStore";
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
 * The control generation a send's Computer intent is pinned to. Only a state
 * this connection confirmed counts: a send right after a reload or reconnect
 * can beat the seed, and the carried-over or drafted generation may be stale
 * (another device's Stop advances it), so the thread's server is asked
 * instead. Sends with no Computer intent ask nothing; a draft with no server
 * thread uses the generation it recorded. Undefined when the server cannot
 * answer, or the connection that answered is gone.
 */
export async function readComputerControlGenerationForSend(
  registry: AtomRegistry.AtomRegistry,
  input: {
    /** The server thread the send lands on; null for a draft or a new chat. */
    readonly ref: ScopedThreadRef | null;
    readonly messageText: string;
    readonly computerControlEnabled: boolean;
    /** The generation the draft recorded, used only while there is no server thread. */
    readonly draftGeneration: number | undefined;
  },
): Promise<number | undefined> {
  if (input.ref === null) return input.draftGeneration;
  const mode = resolveComputerInvocationMode({
    messageText: input.messageText,
    enableComputerControl: input.computerControlEnabled,
  });
  if (mode === "off") return undefined;
  const ref = input.ref;
  const known = useComputerStateStore.getState().threadStates[scopedThreadKey(ref)];
  if (known !== undefined && isComputerThreadStateCurrent(known)) return known.controlGeneration;
  const isCurrent = computerEnvironmentFence(ref.environmentId);
  const result = await runAtomCommand(
    registry,
    computerEnvironment.threadState,
    { environmentId: ref.environmentId, input: { threadId: ref.threadId } },
    { reportFailure: false },
  );
  if (!AsyncResult.isSuccess(result) || !isCurrent()) return undefined;
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
