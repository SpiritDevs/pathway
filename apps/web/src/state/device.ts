import { useEffect, useMemo, useState } from "react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { createDeviceEnvironmentAtoms } from "@spiritdevs/client-runtime/state/device";
import {
  type DeviceHubAccess,
  type DeviceHubCredentials,
  deviceHubAccessAt,
  resolveDeviceHubCredentials,
} from "@spiritdevs/client-runtime/state/deviceHubAccess";
import type {
  DeviceControlState,
  DeviceServiceState,
  DeviceSession,
  DeviceSummary,
  EnvironmentId,
} from "@spiritdevs/contracts";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "./session";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "./query";

export const deviceEnvironment = createDeviceEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_DEVICE_STATE: DeviceServiceState = {
  hosts: [],
  hostStatus: "disabled",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: false,
  agentAccessEnabled: false,
  hubBasePath: "/api/device-hub",
  revision: 0,
};

export function useDeviceState(environmentId: EnvironmentId | null): {
  readonly state: DeviceServiceState;
  readonly loaded: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
} {
  const query = useEnvironmentQuery(
    environmentId === null ? null : deviceEnvironment.state({ environmentId, input: {} }),
  );
  return {
    state: query.data ?? EMPTY_DEVICE_STATE,
    loaded: query.data !== null,
    error: query.error,
    refresh: query.refresh,
  };
}

const deviceStateAtom = (environmentId: EnvironmentId) =>
  deviceEnvironment.state({ environmentId, input: {} });

/** Only the hub path, so stream consumers skip lease and status publications. */
const deviceHubBasePathAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    Option.match(AsyncResult.value(get(deviceStateAtom(environmentId))), {
      onNone: () => EMPTY_DEVICE_STATE.hubBasePath,
      onSome: (state) => state.hubBasePath,
    }),
  ).pipe(Atom.withLabel(`device-hub-base-path:${environmentId}`)),
);

/**
 * One device's control record without its expiry, which renewals republish every 10 seconds.
 * Equal selections compare equal, so a lease re-renders only when control actually moves.
 */
export function selectDeviceControl(
  result: AsyncResult.AsyncResult<DeviceServiceState, unknown>,
  hostId: string,
  deviceId: string,
): DeviceControlSelection {
  const state = Option.getOrNull(AsyncResult.value(result));
  const control = state?.controls?.find(
    (entry) => entry.hostId === hostId && entry.deviceId === deviceId,
  );
  return {
    supported: state?.supportsDeviceControl === true,
    supportsToolRestart: state?.supportsToolRestart === true,
    error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
    control: control
      ? { generation: control.generation, phase: control.phase, owner: control.owner }
      : null,
  };
}

const deviceControlSelectionAtom = Atom.family((key: string) => {
  const [environmentId, hostId, deviceId] = key.split("\u0000") as [EnvironmentId, string, string];
  return Atom.make((get) =>
    selectDeviceControl(get(deviceStateAtom(environmentId)), hostId, deviceId),
  ).pipe(Atom.withEquality(Equal.equals), Atom.withLabel(`device-control-selection:${key}`));
});

export type DeviceWorkspaceTarget = {
  readonly session: DeviceSession;
  readonly device: DeviceSummary;
  readonly hostLabel: string;
  /** Companion choices for a Watch; empty for other devices so their changes don't reach it. */
  readonly devices: ReadonlyArray<DeviceSummary>;
};

const NO_DEVICES: ReadonlyArray<DeviceSummary> = [];

/**
 * The thread's open device, its session and host label. Equal snapshots keep their identity, so
 * the workspace and its stream skip publications that only move control or other devices.
 */
const deviceWorkspaceTargetAtom = Atom.family((key: string) => {
  const [environmentId, threadId, hostId, deviceId] = key.split("\u0000") as [
    EnvironmentId,
    string,
    string,
    string,
  ];
  return Atom.make((get): DeviceWorkspaceTarget | null => {
    const state = Option.getOrNull(AsyncResult.value(get(deviceStateAtom(environmentId))));
    const session = state?.sessions.find(
      (entry) =>
        entry.threadId === threadId && entry.hostId === hostId && entry.deviceId === deviceId,
    );
    const device = session
      ? state?.devices.find((entry) => entry.hostId === hostId && entry.id === deviceId)
      : undefined;
    if (!state || !session || !device) return null;
    const hostLabel = state.hosts.find((host) => host.id === hostId)?.label ?? "Device host";
    const devices = device.family === "watch" ? state.devices : NO_DEVICES;
    return { session, device, hostLabel, devices };
  }).pipe(Atom.withEquality(Equal.equals), Atom.withLabel(`device-workspace-target:${key}`));
});

const NO_WORKSPACE_TARGET_ATOM = Atom.make<DeviceWorkspaceTarget | null>(null).pipe(
  Atom.withLabel("device-workspace-target:none"),
);

export function useDeviceWorkspaceTarget(
  environmentId: EnvironmentId,
  threadId: string,
  target: { readonly hostId: string; readonly deviceId: string } | null | undefined,
): DeviceWorkspaceTarget | null {
  return useAtomValue(
    target
      ? deviceWorkspaceTargetAtom(
          `${environmentId}\u0000${threadId}\u0000${target.hostId}\u0000${target.deviceId}`,
        )
      : NO_WORKSPACE_TARGET_ATOM,
  );
}

export type DeviceControlSelection = {
  readonly supported: boolean;
  readonly supportsToolRestart: boolean;
  readonly error: string | null;
  /** Null while state loads or lacks the device's record, which says nothing about its phase. */
  readonly control: Pick<DeviceControlState, "generation" | "phase" | "owner"> | null;
};

/** What a control lease needs from device state, and a way to re-read it. */
export function useDeviceControlSelection(
  environmentId: EnvironmentId,
  hostId: string,
  deviceId: string,
): DeviceControlSelection & { readonly refresh: () => void } {
  const selection = useAtomValue(
    deviceControlSelectionAtom(`${environmentId}\u0000${hostId}\u0000${deviceId}`),
  );
  const refresh = useAtomRefresh(deviceStateAtom(environmentId));
  return { ...selection, refresh };
}

export type DeviceThreadSessions = {
  readonly sessions: ReadonlyArray<DeviceSession>;
  /** The devices those sessions name that state already describes. */
  readonly devices: ReadonlyArray<DeviceSummary>;
};

/** One thread's device sessions, or null until state loads. */
export function selectDeviceThreadSessions(
  state: DeviceServiceState | null,
  threadId: string,
): DeviceThreadSessions | null {
  if (state === null) return null;
  const sessions = state.sessions.filter((session) => session.threadId === threadId);
  const devices = state.devices.filter((device) =>
    sessions.some((session) => session.hostId === device.hostId && session.deviceId === device.id),
  );
  return { sessions, devices };
}

const deviceThreadSessionsAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = key.split("\u0000") as [EnvironmentId, string];
  return Atom.make((get) =>
    selectDeviceThreadSessions(
      Option.getOrNull(AsyncResult.value(get(deviceStateAtom(environmentId)))),
      threadId,
    ),
  ).pipe(Atom.withEquality(Equal.equals), Atom.withLabel(`device-thread-sessions:${key}`));
});

const NO_THREAD_SESSIONS_ATOM = Atom.make<DeviceThreadSessions | null>(null).pipe(
  Atom.withLabel("device-thread-sessions:none"),
);

/**
 * A thread's device sessions. Equal snapshots keep their identity, so the thread view skips
 * lease renewals and other threads' sessions.
 */
export function useDeviceThreadSessions(
  environmentId: EnvironmentId | null,
  threadId: string | null,
): DeviceThreadSessions | null {
  return useAtomValue(
    environmentId === null || threadId === null
      ? NO_THREAD_SESSIONS_ATOM
      : deviceThreadSessionsAtom(`${environmentId}\u0000${threadId}`),
  );
}

const TICKET_RENEW_MARGIN_MS = 60_000;
const TICKET_RETRY_MS = 15_000;

/**
 * Hub access for one environment. Bearer and DPoP connections mint a ticket
 * here; a stream that gets a 401 back refreshes this atom and reconnects.
 * Keyed on the prepared connection so a re-pair produces new credentials.
 */
const deviceHubAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      const refreshIn = (delayMs: number) =>
        Effect.sync(() => {
          // @effect-diagnostics-next-line globalTimersInEffect:off - The atom finalizer clears this renewal timer.
          const timer = setTimeout(() => get.refreshSelf(), Math.max(0, delayMs));
          get.addFinalizer(() => clearTimeout(timer));
        });
      return resolveDeviceHubCredentials({ prepared }).pipe(
        // Rotate a minute early so fold, accessibility and reconnects never go
        // out with a dead ticket. Live streams read the newest one.
        Effect.tap((credentials) =>
          credentials.expiresAt === null
            ? Effect.void
            : refreshIn(credentials.expiresAt - Date.now() - TICKET_RENEW_MARGIN_MS),
        ),
        // A failed mint keeps retrying; the previous ticket stays usable until it expires.
        Effect.tapError(() => refreshIn(TICKET_RETRY_MS)),
      );
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`device-hub-access:${environmentId}`)),
);

export function useDeviceHubAccess(
  environmentId: EnvironmentId | null,
  hostId = "local",
): DeviceHubAccess | null {
  const result = useAtomValue(
    environmentId === null ? EMPTY_ACCESS_ATOM : deviceHubAccessAtom(environmentId),
  );
  const hubBasePath = useAtomValue(
    environmentId === null ? EMPTY_HUB_BASE_PATH_ATOM : deviceHubBasePathAtom(environmentId),
  );
  // A failed renewal still carries the last credentials; use them until they expire.
  const credentials = Option.getOrNull(AsyncResult.value(result));
  const expiresAt = credentials?.expiresAt ?? null;
  // Expiry must surface on time even while renewal retries are still pending.
  const [lapsed, setLapsed] = useState<number | null>(null);
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = setTimeout(() => setLapsed(expiresAt), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt]);
  const expired = expiresAt !== null && lapsed === expiresAt;
  return useMemo(() => {
    if (credentials === null || expired || deviceHubCredentialsExpired(credentials)) return null;
    const access = deviceHubAccessAt(credentials, hubBasePath);
    // The hub proxy picks the simulator host from `hostId`.
    return { ...access, query: { ...access.query, hostId } };
  }, [credentials, expired, hubBasePath, hostId]);
}

const EMPTY_HUB_BASE_PATH_ATOM = Atom.make(EMPTY_DEVICE_STATE.hubBasePath).pipe(
  Atom.withLabel("device-hub-base-path:empty"),
);

const EMPTY_ACCESS_ATOM = Atom.make(AsyncResult.initial<DeviceHubCredentials, never>()).pipe(
  Atom.withLabel("device-hub-access:empty"),
);

/** Why this environment's hub credentials could not be resolved, e.g. a ticket request timed out. */
const deviceHubCredentialsExpired = (credentials: DeviceHubCredentials) =>
  credentials.expiresAt !== null && Date.now() >= credentials.expiresAt;

export function useDeviceHubAccessError(environmentId: EnvironmentId | null): string | null {
  const result = useAtomValue(
    environmentId === null ? EMPTY_ACCESS_ATOM : deviceHubAccessAtom(environmentId),
  );
  return AsyncResult.isFailure(result)
    ? "Could not authorize the device stream with this environment."
    : null;
}

export function refreshDeviceHubAccess(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(deviceHubAccessAtom(environmentId));
}
