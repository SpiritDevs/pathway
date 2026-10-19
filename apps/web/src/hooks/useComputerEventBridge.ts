// FILE: useComputerEventBridge.ts
// Purpose: Capture computer events per environment and arm the in-chat preview sessions.
// Layer: Web event bridge hook
// Exports: useComputerEventBridge, useComputerEnvironmentEvents, useComputerEnvironmentLifetime
// and their pure handlers
// Depends on: computerEnvironment.events, computerStateStore, computerPreviewStore
//
// The computer engine lives in apps/server, so every signal is a push on the
// environment's RPC socket and this works in a plain browser tab, a remote
// browser, and the desktop app alike.
//
// `computer.open-pane-requested` arms the owning thread's preview session.
// The in-chat popover is the only Computer surface.

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import type { SupervisorConnectionState } from "@spiritdevs/client-runtime/connection";
import { runAtomCommand } from "@spiritdevs/client-runtime/state/runtime";
import type {
  ComputerEvent,
  DesktopComputerBridge,
  EnvironmentId,
  ThreadComputerState,
} from "@spiritdevs/contracts";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";
import { useContext, useEffect, useRef } from "react";

import { computerActionStatusLabel } from "~/components/computer/ComputerPanel.logic";
import { toastManager } from "~/components/ui/toast";
import { removedThreadComputerStateIds } from "~/components/chat/ComputerPreviewPopover.logic";
import { environmentCatalog } from "~/connection/catalog";
import { computerEnvironment } from "~/state/computer";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useComputerPreviewStore } from "../computerPreviewStore";
import { computerEnvironmentFence, useComputerStateStore } from "../computerStateStore";

/** Re-pull one environment's status into the cached copy every surface reads. */
export function refreshComputerStatus(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
): void {
  const isCurrent = computerEnvironmentFence(environmentId);
  void runAtomCommand(
    registry,
    computerEnvironment.refreshStatus,
    { environmentId, input: {} },
    { reportFailure: false },
  ).then((result) => {
    if (AsyncResult.isSuccess(result) && isCurrent()) {
      useComputerStateStore.getState().setStatus(environmentId, result.value);
    }
  });
}

/** Apply one pushed computer event to the environment's slice of both stores. */
export function applyComputerEvent(
  environmentId: EnvironmentId,
  event: ComputerEvent,
  refreshStatus: (environmentId: EnvironmentId) => void,
): void {
  const store = useComputerStateStore.getState();
  const preview = useComputerPreviewStore.getState();
  switch (event.type) {
    case "computer.thread-state":
      store.upsertThreadState(environmentId, event.state);
      break;
    case "computer.windows-changed":
      store.applyWindowsChanged(environmentId, event.windows);
      break;
    case "computer.action": {
      store.recordAction(environmentId, event);
      const threadId = event.threadId;
      if (threadId) {
        const ref = { environmentId, threadId };
        const label = computerActionStatusLabel(
          event,
          store.threadStates[scopedThreadKey(ref)]?.windows,
        );
        if (label !== null) {
          preview.noteThreadActionLabel(ref, label);
        }
      }
      break;
    }
    case "computer.open-pane-requested":
      // The server sends this once per lease. What honors it is the preview
      // session on the owning thread, armed whether or not that chat is on
      // screen.
      preview.requestPreviewSurface({ environmentId, threadId: event.threadId });
      break;
    case "computer.input-stopped":
      // Host-wide: update the latch every surface reads, and re-pull the
      // status the settings panel shows so its indicator flips at the press
      // rather than on the next interval.
      store.setInputStopped(environmentId, event.stopped);
      refreshStatus(environmentId);
      break;
    case "computer.frame":
      // Frames ride the dedicated binary frame socket, never this channel.
      break;
  }
}

/**
 * Feed thread-state changes into the preview session machine. Thread state
 * also arrives through `computer.getThreadState` seeds, which never pass the
 * push handler; watching the store feeds both paths into the same edge
 * detection, and an environment reset ends that environment's sessions.
 */
export function syncComputerPreviewSessions(
  next: Readonly<Record<string, ThreadComputerState | undefined>>,
  previous: Readonly<Record<string, ThreadComputerState | undefined>>,
): void {
  if (next === previous) return;
  const preview = useComputerPreviewStore.getState();
  // Keys, not bare states: the scoped key is what names the environment.
  for (const key of Object.keys(next)) {
    const state = next[key];
    if (state === undefined || state === previous[key]) continue;
    const ref = parseScopedThreadKey(key);
    if (ref) preview.noteThreadComputerState(ref.environmentId, state);
  }
  for (const key of removedThreadComputerStateIds(next, previous)) {
    const ref = parseScopedThreadKey(key);
    if (ref) preview.removePreviewSession(ref);
  }
}

export function subscribeComputerPreviewSessions(): () => void {
  return useComputerStateStore.subscribe((state, previous) =>
    syncComputerPreviewSessions(state.threadStates, previous.threadStates),
  );
}

type ComputerPermissionBridge = Pick<DesktopComputerBridge, "onState">;

/**
 * A native grant can land while System Settings owns focus. The desktop
 * bridge describes the desktop's own host, so only the primary local
 * environment's cached status is refreshed, and only once some surface has
 * already asked for it.
 */
export function subscribeComputerPermissionStatus(
  refresh: () => void,
  bridge: ComputerPermissionBridge | null = globalThis.window?.desktopBridge?.computer ?? null,
): () => void {
  if (!bridge) return () => undefined;
  let previous: string | undefined;
  return bridge.onState((state) => {
    // Snapshots that never asked about Accessibility do not establish the
    // grant set and must not turn an unused Computer feature on.
    if (!state.supported || state.accessibilityPermission === undefined) return;
    const grants = [
      state.accessibilityPermission,
      state.inputMonitoringPermission,
      state.screenRecordingPermission,
    ].join(",");
    if (grants === previous) return;
    previous = grants;
    refresh();
  });
}

type ComputerSetupErrorBridge = Pick<DesktopComputerBridge, "onError">;

/**
 * Native permission setup can fail while System Settings owns focus. The
 * desktop brings the app forward and pushes the failure, which is toasted so
 * an open guide does not keep watching for a change that will never land.
 */
export function subscribeComputerSetupErrors(
  bridge: ComputerSetupErrorBridge | null = globalThis.window?.desktopBridge?.computer ?? null,
): () => void {
  if (!bridge) return () => undefined;
  return bridge.onError((error) => {
    toastManager.add({
      type: "error",
      title: "Couldn't set up computer control",
      description: error.message,
    });
  });
}

/**
 * Deliver every pushed event of one environment's `computer.events` stream.
 * The same result object can be re-announced (a `waiting` flip on
 * reconnect), so events are deduplicated by identity.
 */
export function subscribeComputerEnvironmentEvents(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<ComputerEvent, unknown>>,
  onEvent: (event: ComputerEvent) => void,
): () => void {
  let lastEvent: ComputerEvent | undefined;
  return registry.subscribe(atom, (result) => {
    if (!AsyncResult.isSuccess(result) || result.value === lastEvent) return;
    lastEvent = result.value;
    onEvent(result.value);
  });
}

const NO_CONNECTION_STATE_ATOM: Atom.Atom<
  AsyncResult.AsyncResult<SupervisorConnectionState, unknown>
> = Atom.make(AsyncResult.initial<SupervisorConnectionState, unknown>(false)).pipe(
  Atom.withLabel("computer:no-connection-state"),
);

/** The connection generation while connected, else null. */
export function useConnectedGeneration(environmentId: EnvironmentId | null): number | null {
  const result = useAtomValue(
    environmentId === null ? NO_CONNECTION_STATE_ATOM : environmentCatalog.stateAtom(environmentId),
  );
  if (!AsyncResult.isSuccess(result)) return null;
  return result.value.phase === "connected" ? result.value.generation : null;
}

/**
 * One environment's event pipe. The next connection may reach a restarted
 * server whose thread-state versions start over, which the version gate
 * would reject as stragglers, so the environment's thread states are rebased
 * for the seeds and pushes to replace as soon as the connection drops (or,
 * if the drop was never rendered, when the new generation shows up). That
 * also fences answers the old connection owed. Previews, their Hide, float
 * and layout survive a reconnect. Closing the pipe keeps them too, along with
 * the status that closed it; `useComputerEnvironmentLifetime` clears them.
 */
export function useComputerEnvironmentEvents(environmentId: EnvironmentId): void {
  const registry = useContext(RegistryContext);
  const generation = useConnectedGeneration(environmentId);
  const seenGeneration = useRef<number | null>(null);

  useEffect(() => {
    if (seenGeneration.current !== null && seenGeneration.current !== generation) {
      useComputerStateStore.getState().rebaseEnvironment(environmentId);
    }
    seenGeneration.current = generation;
  }, [environmentId, generation]);

  useEffect(
    () =>
      subscribeComputerEnvironmentEvents(
        registry,
        computerEnvironment.events({ environmentId, input: {} }),
        (event) =>
          applyComputerEvent(environmentId, event, (id) => refreshComputerStatus(registry, id)),
      ),
    [environmentId, registry],
  );
}

/**
 * Mounted for as long as the environment is in the catalog, whether or not
 * its event pipe is open. Unmounting means the environment left, so nothing
 * of it may linger.
 */
export function useComputerEnvironmentLifetime(environmentId: EnvironmentId): void {
  useEffect(
    () => () => {
      useComputerStateStore.getState().clearEnvironment(environmentId);
      useComputerPreviewStore.getState().clearEnvironment(environmentId);
    },
    [environmentId],
  );
}

/** Mounted once at the app root, including while settings or split view is open. */
export function useComputerEventBridge(): void {
  const registry = useContext(RegistryContext);
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  useEffect(() => subscribeComputerPreviewSessions(), []);
  useEffect(() => subscribeComputerSetupErrors(), []);

  useEffect(() => {
    if (primaryEnvironmentId === null) return;
    return subscribeComputerPermissionStatus(() => {
      if (useComputerStateStore.getState().statusByEnvironment[primaryEnvironmentId]) {
        refreshComputerStatus(registry, primaryEnvironmentId);
      }
    });
  }, [primaryEnvironmentId, registry]);
}
