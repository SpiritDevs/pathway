import {
  COMPUTER_SURFACE_METHODS,
  COMPUTER_WS_METHODS,
  WORKFLOW_RECORDING_METHODS,
} from "@spiritdevs/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Environment-scoped Computer RPCs. Frames never travel through these: live
 * stills use the dedicated frame socket (see `computerFrameSocket.ts`).
 */
export function createComputerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const controlScheduler = createAtomCommandScheduler();
  const inputScheduler = createAtomCommandScheduler();
  const provisionScheduler = createAtomCommandScheduler();
  const recordingScheduler = createAtomCommandScheduler();
  const surfaceScheduler = createAtomCommandScheduler();
  const threadKey = ({
    environmentId,
    input,
  }: {
    environmentId: string;
    input: { threadId: string };
  }) => JSON.stringify([environmentId, input.threadId]);
  return {
    recordingStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer:recording-status",
      tag: WORKFLOW_RECORDING_METHODS.status,
    }),
    startRecording: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer:recording-start",
      tag: WORKFLOW_RECORDING_METHODS.start,
      scheduler: recordingScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    stopRecording: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer:recording-stop",
      tag: WORKFLOW_RECORDING_METHODS.stop,
      scheduler: recordingScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    cancelRecording: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer:recording-cancel",
      tag: WORKFLOW_RECORDING_METHODS.cancel,
      scheduler: recordingScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:computer:status",
      tag: COMPUTER_WS_METHODS.getStatus,
      staleTimeMs: 10_000,
    }),
    refreshStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer:refresh-status",
      tag: COMPUTER_WS_METHODS.getStatus,
    }),
    auditHistory: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer:audit-history",
      tag: COMPUTER_WS_METHODS.getAuditHistory,
    }),
    provision: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer:provision",
      tag: COMPUTER_WS_METHODS.provision,
      scheduler: provisionScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
    threadState: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer:thread-state",
      tag: COMPUTER_WS_METHODS.getThreadState,
    }),
    setControlEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer:set-control-enabled",
      tag: COMPUTER_WS_METHODS.setControlEnabled,
      scheduler: controlScheduler,
      concurrency: { mode: "serial", key: threadKey },
    }),
    inputClick: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer:input-click",
      tag: COMPUTER_WS_METHODS.inputClick,
      scheduler: inputScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    inputScroll: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer:input-scroll",
      tag: COMPUTER_WS_METHODS.inputScroll,
      scheduler: inputScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    inputKey: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer:input-key",
      tag: COMPUTER_WS_METHODS.inputKey,
      scheduler: inputScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:computer:events",
      tag: COMPUTER_WS_METHODS.subscribeEvents,
    }),
    /** Who controls the environment's screen. Carries no frames; the surface socket does. */
    surfaceState: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:computer:surface-state",
      tag: COMPUTER_SURFACE_METHODS.subscribe,
      idleTtlMs: 0,
    }),
    takeSurfaceControl: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer:surface-take-control",
      tag: COMPUTER_SURFACE_METHODS.takeControl,
      scheduler: surfaceScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    releaseSurfaceControl: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer:surface-release-control",
      tag: COMPUTER_SURFACE_METHODS.releaseControl,
      scheduler: surfaceScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    /** Serial with take/release/hand-back, so input never lands after control has moved. */
    surfaceInput: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer:surface-input",
      tag: COMPUTER_SURFACE_METHODS.input,
      scheduler: surfaceScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    surfaceHandBack: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:computer:surface-hand-back",
      tag: COMPUTER_SURFACE_METHODS.handBack,
      scheduler: surfaceScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
  };
}

export type ComputerEnvironmentAtoms = ReturnType<typeof createComputerEnvironmentAtoms>;
