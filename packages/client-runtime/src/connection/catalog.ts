import {
  DesktopSshEnvironmentTargetSchema,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
} from "@spiritdevs/contracts";
import { isLoopbackHost } from "@spiritdevs/shared/preview";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  type ConnectionTarget,
} from "./model.ts";

const ConnectionProfileBase = {
  connectionId: Schema.String,
  environmentId: EnvironmentId,
  label: Schema.String,
};

export class BearerConnectionProfile extends Schema.TaggedClass<BearerConnectionProfile>()(
  "BearerConnectionProfile",
  {
    ...ConnectionProfileBase,
    httpBaseUrl: Schema.String,
    wsBaseUrl: Schema.String,
  },
) {}

export class SshConnectionProfile extends Schema.TaggedClass<SshConnectionProfile>()(
  "SshConnectionProfile",
  {
    ...ConnectionProfileBase,
    target: DesktopSshEnvironmentTargetSchema,
  },
) {}

export const ConnectionProfile = Schema.Union([BearerConnectionProfile, SshConnectionProfile]);
export type ConnectionProfile = typeof ConnectionProfile.Type;

export interface ConnectionCatalogEntry {
  readonly target: ConnectionTarget;
  readonly profile: Option.Option<ConnectionProfile>;
  /** Last advertised host metadata, when a local session or company registry has supplied it. */
  readonly descriptor?: ExecutionEnvironmentDescriptor;
  /** Optional reachability observation supplied by a catalog source, never connection config. */
  readonly freshness?: ConnectionCatalogFreshness;
}

export interface ConnectionCatalogFreshness {
  readonly lastSeenAt: number | null;
}

function isLoopbackUrl(url: string): boolean {
  return URL.canParse(url) && isLoopbackHost(new URL(url).hostname);
}

/**
 * True when the entry's socket never leaves this machine, so the platform's
 * online/offline hint says nothing about whether it is reachable. SSH is
 * excluded: its loopback port is a tunnel to a remote host.
 */
export function connectionEntryIsLoopback(entry: ConnectionCatalogEntry): boolean {
  switch (entry.target._tag) {
    case "PrimaryConnectionTarget":
      return isLoopbackUrl(entry.target.wsBaseUrl);
    case "BearerConnectionTarget":
      return Option.exists(
        entry.profile,
        (profile) => profile._tag === "BearerConnectionProfile" && isLoopbackUrl(profile.wsBaseUrl),
      );
    case "RelayConnectionTarget":
    case "SshConnectionTarget":
      return false;
  }
}

export class BearerConnectionCredential extends Schema.TaggedClass<BearerConnectionCredential>()(
  "BearerConnectionCredential",
  {
    token: Schema.String,
  },
) {}

export const ConnectionCredential = Schema.Union([BearerConnectionCredential]);
export type ConnectionCredential = typeof ConnectionCredential.Type;

export class PrimaryConnectionRegistration extends Schema.TaggedClass<PrimaryConnectionRegistration>()(
  "PrimaryConnectionRegistration",
  {
    target: PrimaryConnectionTarget,
  },
) {}

export class RelayConnectionRegistration extends Schema.TaggedClass<RelayConnectionRegistration>()(
  "RelayConnectionRegistration",
  {
    target: RelayConnectionTarget,
  },
) {}

export class BearerConnectionRegistration extends Schema.TaggedClass<BearerConnectionRegistration>()(
  "BearerConnectionRegistration",
  {
    target: BearerConnectionTarget,
    profile: BearerConnectionProfile,
    credential: BearerConnectionCredential,
  },
) {}

export class SshConnectionRegistration extends Schema.TaggedClass<SshConnectionRegistration>()(
  "SshConnectionRegistration",
  {
    target: SshConnectionTarget,
    profile: SshConnectionProfile,
  },
) {}

export const ConnectionRegistration = Schema.Union([
  RelayConnectionRegistration,
  BearerConnectionRegistration,
  SshConnectionRegistration,
]);
export type ConnectionRegistration = typeof ConnectionRegistration.Type;

/**
 * Platform-managed registrations are reconciled from the host (the desktop
 * bootstrap IPC) rather than persisted by the user. They cover the primary
 * local environment plus any additional desktop-local backends running
 * alongside it (e.g. a parallel WSL backend). The primary stays on same-origin
 * cookie auth (`PrimaryConnectionRegistration`); secondary local backends live
 * on a separate loopback origin and authenticate with a bearer token minted
 * from their bootstrap credential (`BearerConnectionRegistration`).
 */
export const PlatformConnectionRegistration = Schema.Union([
  PrimaryConnectionRegistration,
  BearerConnectionRegistration,
]);
export type PlatformConnectionRegistration = typeof PlatformConnectionRegistration.Type;

export function connectionRegistrationTarget(
  registration: ConnectionRegistration | PrimaryConnectionRegistration,
): ConnectionTarget {
  return registration.target;
}

export function connectionRegistrationCatalogEntry(
  registration: ConnectionRegistration | PrimaryConnectionRegistration,
): ConnectionCatalogEntry {
  switch (registration._tag) {
    case "PrimaryConnectionRegistration":
    case "RelayConnectionRegistration":
      return {
        target: registration.target,
        profile: Option.none(),
      };
    case "BearerConnectionRegistration":
    case "SshConnectionRegistration":
      return {
        target: registration.target,
        profile: Option.some(registration.profile),
      };
  }
}
