import type { DeviceControlProof, EnvironmentId } from "@spiritdevs/contracts";
import type * as Cause from "effect/Cause";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { randomUUID } from "~/lib/utils";
import { deviceEnvironment, useDeviceControlSelection } from "~/state/device";
import { useEnvironmentConnectionState } from "~/state/environments";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  deviceControlErrorCode,
  deviceControlErrorCopy,
  deviceControlLost,
  type DeviceControlCode,
} from "./deviceControl";

/** Leases last 30 seconds on the environment; renew well inside that. */
export const DEVICE_CONTROL_RENEW_MS = 10_000;

type Lease = { readonly generation: number; readonly connection: number | null };

const DEVICE_CONTROL_DISCONNECTED =
  "Lost the connection to the environment, which ended your control. Take control again.";

export type DeviceControlView =
  | { readonly kind: "unsupported" }
  | { readonly kind: "unknown" }
  | { readonly kind: "you" }
  | { readonly kind: "agent"; readonly threadId: string; readonly runId: string }
  | { readonly kind: "viewer" }
  | { readonly kind: "draining" }
  | { readonly kind: "none" };

/**
 * This viewer's environment control lease for one device. Mount keyed by device; hiding or
 * unmounting releases, and expiry covers a release that never arrives. Input is enabled only
 * while the environment's latest state names this viewer and generation as `held`, on the same
 * connection that acquired it.
 */
export function useDeviceControlLease(options: {
  readonly environmentId: EnvironmentId;
  readonly hostId: string;
  readonly deviceId: string;
  readonly visible: boolean;
}) {
  const { environmentId, hostId, deviceId, visible } = options;
  const selection = useDeviceControlSelection(environmentId, hostId, deviceId);
  const { control, refresh } = selection;
  const connectionState = useEnvironmentConnectionState(environmentId).data;
  // The environment drops a viewer's lease with the RPC connection that acquired it.
  const connection = connectionState?.phase === "connected" ? connectionState.generation : null;
  const acquire = useAtomCommand(deviceEnvironment.acquireControl, { reportFailure: false });
  const renew = useAtomCommand(deviceEnvironment.renewControl, { reportFailure: false });
  const releaseControl = useAtomCommand(deviceEnvironment.releaseControl, {
    reportFailure: false,
  });
  const restartTools = useAtomCommand(deviceEnvironment.restartTools, { reportFailure: false });
  const [viewerId] = useState(randomUUID);
  const [lease, setLeaseState] = useState<Lease | null>(null);
  const [pending, setPending] = useState<"acquire" | "release" | null>(null);
  const [error, setErrorState] = useState<{
    readonly message: string;
    readonly code: DeviceControlCode | null;
  } | null>(null);
  const [recovering, setRecovering] = useState(false);
  const setError = useCallback(
    (message: string | null, code: DeviceControlCode | null = null) =>
      setErrorState(message === null ? null : { message, code }),
    [],
  );
  // Cleanup and late RPC results read the newest values, not a render's closure.
  const leaseRef = useRef<Lease | null>(null);
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  // Bumped by every hide and unmount, so an acquisition started before it is handed back.
  const epochRef = useRef(0);
  const releasingRef = useRef<Promise<boolean> | null>(null);
  const setLease = (next: Lease | null) => {
    leaseRef.current = next;
    setLeaseState(next);
  };
  const generation = lease?.generation ?? null;

  const supported = selection.supported;
  const unknown = selection.error !== null || connection === null;
  const held =
    lease !== null &&
    lease.connection === connection &&
    control?.phase === "held" &&
    control.generation === lease.generation &&
    control.owner?.kind === "viewer" &&
    control.owner.viewerId === viewerId;
  const active = supported && held && visible && !unknown && pending !== "release";
  const proof = useMemo<DeviceControlProof | null>(
    () => (active && generation !== null ? { viewerId, generation } : null),
    [active, generation, viewerId],
  );

  const fail = useCallback((cause: Cause.Cause<unknown>) => {
    const code = deviceControlErrorCode(cause);
    setError(code ? deviceControlErrorCopy[code] : formatEnvironmentQueryError(cause), code);
    return code;
  }, []);

  /**
   * Mutations that fail with a control code report it here, with the generation they were sent
   * under, so the lease state stays honest. Results from an older lease are ignored.
   */
  const reportError = useCallback(
    (code: DeviceControlCode, sentWith: number) => {
      if (leaseRef.current?.generation !== sentWith) return;
      setError(deviceControlErrorCopy[code], code);
      if (deviceControlLost(code)) setLease(null);
      if (code === "stale_generation") refresh();
    },
    [refresh],
  );

  /** Resolves true only when the environment acknowledges this viewer's release. */
  const release = useCallback((): Promise<boolean> => {
    const releasing = leaseRef.current;
    if (releasing === null) return releasingRef.current ?? Promise.resolve(true);
    // Input stops before the environment acknowledges, so nothing races the hand-back.
    setLease(null);
    setPending("release");
    const request = releaseControl({
      environmentId,
      input: { hostId, deviceId, viewerId, generation: releasing.generation },
    }).then((result) => {
      if (releasingRef.current === request) {
        releasingRef.current = null;
        setPending(null);
      }
      if (result._tag === "Success") return true;
      // A lost lease still ends this viewer's input, but it is not an acknowledged hand-back.
      if (fail(result.cause) === "stale_generation") refresh();
      return false;
    });
    releasingRef.current = request;
    return request;
  }, [deviceId, environmentId, fail, hostId, refresh, releaseControl, viewerId]);

  const take = useCallback(async () => {
    if (!supported || unknown || pending !== null) return;
    const epoch = epochRef.current;
    const acquiredOn = connectionRef.current;
    setPending("acquire");
    setError(null);
    const result = await acquire({ environmentId, input: { hostId, deviceId, viewerId } });
    if (epochRef.current !== epoch) {
      // Hidden or unmounted since asking: hand the lease straight back, even if shown again.
      if (result._tag === "Success")
        void releaseControl({
          environmentId,
          input: { hostId, deviceId, viewerId, generation: result.value.generation },
        });
      return;
    }
    setPending(null);
    if (result._tag === "Failure") {
      if (fail(result.cause) === "stale_generation") refresh();
      return;
    }
    if (connectionRef.current !== acquiredOn) {
      setError(DEVICE_CONTROL_DISCONNECTED);
      return;
    }
    setLease({ generation: result.value.generation, connection: acquiredOn });
  }, [
    acquire,
    deviceId,
    environmentId,
    fail,
    hostId,
    pending,
    refresh,
    releaseControl,
    supported,
    unknown,
    viewerId,
  ]);

  /** Restarts the host's helpers, the only way past `input_unconfirmed`. */
  const recover = useCallback(async () => {
    setRecovering(true);
    const result = await restartTools({ environmentId, input: { hostId } });
    setRecovering(false);
    // The error and its button stay up during the restart, so the way out never disappears.
    if (result._tag === "Failure") fail(result.cause);
    else setError(null);
  }, [environmentId, fail, hostId, restartTools, setError]);

  // Generations only grow, so a newer one, or ours no longer held, means control moved on.
  useEffect(() => {
    if (lease === null || control === null) return;
    if (control.generation < lease.generation) return;
    if (control.generation === lease.generation && control.phase === "held") return;
    setLease(null);
    setError(
      control.owner?.kind === "viewer" && control.owner.viewerId !== viewerId
        ? "Someone else took control of this device."
        : deviceControlErrorCopy.stale_generation,
    );
  }, [control, lease, viewerId]);

  // A dropped or replaced connection already released the lease on the environment.
  useEffect(() => {
    if (lease === null || lease.connection === connection) return;
    setLease(null);
    setError(DEVICE_CONTROL_DISCONNECTED);
  }, [connection, lease]);

  useEffect(() => {
    if (proof === null) return;
    const timer = setInterval(() => {
      void renew({ environmentId, input: { hostId, deviceId, ...proof } }).then((result) => {
        if (result._tag === "Success" || leaseRef.current?.generation !== proof.generation) return;
        const code = deviceControlErrorCode(result.cause);
        if (code) return reportError(code, proof.generation);
        // An unconfirmed renewal can no longer vouch for the lease.
        setLease(null);
        setError(DEVICE_CONTROL_DISCONNECTED);
      });
    }, DEVICE_CONTROL_RENEW_MS);
    return () => clearInterval(timer);
  }, [deviceId, environmentId, hostId, proof, renew, reportError]);

  const releaseRef = useRef(release);
  releaseRef.current = release;
  useEffect(() => {
    if (visible) return;
    epochRef.current++;
    setPending((current) => (current === "acquire" ? null : current));
    void releaseRef.current();
  }, [visible]);
  useEffect(
    () => () => {
      epochRef.current++;
      void releaseRef.current();
    },
    [],
  );

  const view: DeviceControlView = !supported
    ? { kind: "unsupported" }
    : unknown
      ? { kind: "unknown" }
      : proof
        ? { kind: "you" }
        : control?.phase === "draining"
          ? { kind: "draining" }
          : control?.phase === "held" && control.owner?.kind === "agent"
            ? { kind: "agent", threadId: control.owner.threadId, runId: control.owner.runId }
            : control?.phase === "held" && control.owner?.kind === "viewer"
              ? { kind: "viewer" }
              : { kind: "none" };

  return {
    supported,
    /** Undefined on environments without leases: input keeps its previous, unfenced behaviour. */
    control: supported ? proof : undefined,
    view,
    /** Acquired but not yet confirmed by state, or waiting on the previous controller to drain. */
    acquiring: pending === "acquire" || (lease !== null && !held && !unknown),
    releasing: pending === "release",
    error: error?.message ?? null,
    dismissError: () => setError(null),
    /** Helper restart is offered when the environment can't confirm earlier input finished. */
    canRecover: selection.supportsToolRestart && error?.code === "input_unconfirmed",
    recovering,
    recover,
    take,
    release,
    reportError,
  };
}

export type DeviceControlLease = ReturnType<typeof useDeviceControlLease>;
