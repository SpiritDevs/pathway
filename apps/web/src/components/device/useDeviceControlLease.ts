import { currentDeviceController } from "@spiritdevs/client-runtime/state/device";
import type { DeviceControlProof, EnvironmentId } from "@spiritdevs/contracts";
import type * as Cause from "effect/Cause";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { randomUUID } from "~/lib/utils";
import { deviceEnvironment, useDeviceState } from "~/state/device";
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
 * while the environment's latest state names this viewer and generation as `held`.
 */
export function useDeviceControlLease(options: {
  readonly environmentId: EnvironmentId;
  readonly hostId: string;
  readonly deviceId: string;
  readonly visible: boolean;
}) {
  const { environmentId, hostId, deviceId, visible } = options;
  const { state, error: stateError, refresh } = useDeviceState(environmentId);
  const acquire = useAtomCommand(deviceEnvironment.acquireControl, { reportFailure: false });
  const renew = useAtomCommand(deviceEnvironment.renewControl, { reportFailure: false });
  const releaseControl = useAtomCommand(deviceEnvironment.releaseControl, {
    reportFailure: false,
  });
  const [viewerId] = useState(randomUUID);
  const [generation, setGenerationState] = useState<number | null>(null);
  const [pending, setPending] = useState<"acquire" | "release" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Cleanup and late RPC results read the newest values, not a render's closure.
  const generationRef = useRef<number | null>(null);
  const activeRef = useRef(true);
  activeRef.current = visible;
  const setGeneration = (next: number | null) => {
    generationRef.current = next;
    setGenerationState(next);
  };

  const supported = state.supportsDeviceControl === true;
  const unknown = stateError !== null;
  const control = currentDeviceController(state, hostId, deviceId);
  const held =
    generation !== null &&
    control?.phase === "held" &&
    control.generation === generation &&
    control.owner?.kind === "viewer" &&
    control.owner.viewerId === viewerId;
  const active = supported && held && visible && !unknown && pending !== "release";
  const proof = useMemo<DeviceControlProof | null>(
    () => (active && generation !== null ? { viewerId, generation } : null),
    [active, generation, viewerId],
  );

  const fail = useCallback((cause: Cause.Cause<unknown>) => {
    const code = deviceControlErrorCode(cause);
    setError(code ? deviceControlErrorCopy[code] : formatEnvironmentQueryError(cause));
    return code;
  }, []);

  /** Mutations that fail with a control code report it here so the lease state stays honest. */
  const reportError = useCallback(
    (code: DeviceControlCode) => {
      setError(deviceControlErrorCopy[code]);
      if (deviceControlLost(code)) setGeneration(null);
      if (code === "stale_generation") refresh();
    },
    [refresh],
  );

  const release = useCallback(async (): Promise<boolean> => {
    const releasing = generationRef.current;
    if (releasing === null) return true;
    // Input stops before the environment acknowledges, so nothing races the hand-back.
    setGeneration(null);
    setPending("release");
    const result = await releaseControl({
      environmentId,
      input: { hostId, deviceId, viewerId, generation: releasing },
    });
    setPending(null);
    if (result._tag === "Success") return true;
    const code = fail(result.cause);
    if (code === "stale_generation") refresh();
    // Losing the lease some other way still means this viewer's input is gone.
    if (code !== null && deviceControlLost(code)) {
      setError(null);
      return true;
    }
    return false;
  }, [deviceId, environmentId, fail, hostId, refresh, releaseControl, viewerId]);

  const take = useCallback(async () => {
    if (!supported || unknown || pending !== null) return;
    setPending("acquire");
    setError(null);
    const result = await acquire({ environmentId, input: { hostId, deviceId, viewerId } });
    setPending(null);
    if (result._tag === "Failure") {
      if (fail(result.cause) === "stale_generation") refresh();
      return;
    }
    const acquired = result.value.generation;
    if (!activeRef.current) {
      // Hidden or unmounted while draining: hand the lease straight back.
      void releaseControl({
        environmentId,
        input: { hostId, deviceId, viewerId, generation: acquired },
      });
      return;
    }
    setGeneration(acquired);
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

  // Generations only grow, so a newer one, or ours no longer held, means control moved on.
  useEffect(() => {
    if (generation === null || control === null) return;
    if (control.generation < generation) return;
    if (control.generation === generation && control.phase === "held") return;
    setGeneration(null);
    setError(
      control.owner?.kind === "viewer" && control.owner.viewerId !== viewerId
        ? "Someone else took control of this device."
        : deviceControlErrorCopy.stale_generation,
    );
  }, [control, generation, viewerId]);

  useEffect(() => {
    if (proof === null) return;
    const timer = setInterval(() => {
      void renew({ environmentId, input: { hostId, deviceId, ...proof } }).then((result) => {
        if (result._tag === "Success") return;
        const code = deviceControlErrorCode(result.cause);
        // A dropped connection leaves the lease to expire; the state stream reports it.
        if (code) reportError(code);
      });
    }, DEVICE_CONTROL_RENEW_MS);
    return () => clearInterval(timer);
  }, [deviceId, environmentId, hostId, proof, renew, reportError]);

  const releaseRef = useRef(release);
  releaseRef.current = release;
  useEffect(() => {
    if (!visible) void releaseRef.current();
  }, [visible]);
  useEffect(
    () => () => {
      activeRef.current = false;
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
    acquiring: pending === "acquire" || (generation !== null && !held && !unknown),
    releasing: pending === "release",
    error,
    dismissError: () => setError(null),
    take,
    release,
    reportError,
  };
}

export type DeviceControlLease = ReturnType<typeof useDeviceControlLease>;
