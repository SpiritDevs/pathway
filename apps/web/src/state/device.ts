import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import { createDeviceEnvironmentAtoms } from "@spiritdevs/client-runtime/state/device";
import {
  type DeviceHubAccess,
  type DeviceHubCredentials,
  deviceHubAccessAt,
  resolveDeviceHubCredentials,
} from "@spiritdevs/client-runtime/state/deviceHubAccess";
import type { DeviceServiceState, EnvironmentId } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "./session";
import { useEnvironmentQuery } from "./query";

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
  const { hubBasePath } = useDeviceState(environmentId).state;
  return useMemo(() => {
    // A failed renewal still carries the last credentials; use them until they expire.
    const credentials = Option.getOrNull(AsyncResult.value(result));
    if (credentials === null || deviceHubCredentialsExpired(credentials)) return null;
    const access = deviceHubAccessAt(credentials, hubBasePath);
    // The hub proxy picks the simulator host from `hostId`.
    return { ...access, query: { ...access.query, hostId } };
  }, [result, hubBasePath, hostId]);
}

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
