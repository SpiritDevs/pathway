import {
  EnvironmentRegistrationEntity,
  type EnvironmentRegistrationEntity as EnvironmentRegistrationEntityType,
  type TeamEntity,
} from "@spiritdevs/client-runtime/sync";
import type { EffectiveConnectionCatalogEntry } from "@spiritdevs/client-runtime/connection";
import type { Discovery } from "@spiritdevs/client-runtime/relay";
import type { EnvironmentId } from "@spiritdevs/contracts";
import type { EnvironmentCommandResult } from "@spiritdevs/contracts/cloudProject";
import * as Schema from "effect/Schema";

import type { EnvironmentCommandRecord } from "../../../cloud/environmentControl";

const isEnvironmentRegistration = Schema.is(EnvironmentRegistrationEntity);

export function environmentRegistrationsFromReplicaValues(
  values: Iterable<unknown>,
): ReadonlyArray<EnvironmentRegistrationEntityType> {
  const registrations: EnvironmentRegistrationEntityType[] = [];
  for (const value of values) {
    if (isEnvironmentRegistration(value)) registrations.push(value);
  }
  return registrations;
}

export interface CompanyEnvironmentRow {
  readonly registration: EnvironmentRegistrationEntityType;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly teamNames: ReadonlyArray<string>;
  readonly catalogSource: "local" | "companyRegistry" | null;
  readonly isInCatalog: boolean;
  readonly isOwnEnvironment: boolean;
}

export type PathwayConnectStatus = "active" | "connecting" | "failed";

export function derivePathwayConnectStatus(input: {
  readonly row: CompanyEnvironmentRow;
  readonly ownCloudLinkPhase: "idle" | "connecting" | "waiting" | "connected" | "exhausted";
  readonly ownManagedEndpointAvailable: boolean | null;
  readonly ownCloudLinkError: string | null;
  readonly remoteRelayAvailability?: Discovery.RelayEnvironmentAvailability | null | undefined;
}): PathwayConnectStatus {
  if (input.row.registration.state !== "active") return "failed";

  if (input.row.isOwnEnvironment) {
    if (input.ownCloudLinkPhase === "exhausted" || input.ownCloudLinkError !== null) {
      return "failed";
    }
    return input.ownCloudLinkPhase === "connected" && input.ownManagedEndpointAvailable === true
      ? "active"
      : "connecting";
  }

  if (input.row.registration.relayLinkState !== "linked") return "failed";
  if (!input.row.registration.managedEndpointAvailable) return "connecting";
  if (input.remoteRelayAvailability === "online") return "active";
  if (input.remoteRelayAvailability === "offline" || input.remoteRelayAvailability === "error") {
    return "failed";
  }
  if (input.remoteRelayAvailability === "checking") return "connecting";
  return "active";
}

export function partitionCompanyEnvironmentRowsByConnection(input: {
  readonly rows: ReadonlyArray<CompanyEnvironmentRow>;
  readonly ownCloudLinkPhase: "idle" | "connecting" | "waiting" | "connected" | "exhausted";
  readonly ownManagedEndpointAvailable: boolean | null;
  readonly ownCloudLinkError: string | null;
  readonly remoteRelayAvailability: ReadonlyMap<
    EnvironmentId,
    Discovery.RelayEnvironmentAvailability
  >;
}): {
  readonly connected: ReadonlyArray<CompanyEnvironmentRow>;
  readonly disconnected: ReadonlyArray<CompanyEnvironmentRow>;
} {
  const connected: CompanyEnvironmentRow[] = [];
  const disconnected: CompanyEnvironmentRow[] = [];

  for (const row of input.rows) {
    const status = derivePathwayConnectStatus({
      row,
      ownCloudLinkPhase: input.ownCloudLinkPhase,
      ownManagedEndpointAvailable: input.ownManagedEndpointAvailable,
      ownCloudLinkError: input.ownCloudLinkError,
      remoteRelayAvailability: input.remoteRelayAvailability.get(row.environmentId),
    });
    (status === "active" ? connected : disconnected).push(row);
  }

  return { connected, disconnected };
}

export function deriveEnvironmentRows(input: {
  readonly registrations: ReadonlyArray<EnvironmentRegistrationEntityType>;
  readonly catalogEntries: ReadonlyMap<EnvironmentId, EffectiveConnectionCatalogEntry>;
  readonly teams: ReadonlyArray<TeamEntity>;
  readonly ownEnvironmentId: EnvironmentId | null;
}): ReadonlyArray<CompanyEnvironmentRow> {
  const teamById = new Map(input.teams.map((team) => [team.id, team]));
  return input.registrations
    .map((registration): CompanyEnvironmentRow => {
      const catalogEntry = input.catalogEntries.get(registration.environmentId);
      return {
        registration,
        environmentId: registration.environmentId,
        label: registration.descriptor.label,
        teamNames: registration.teamIds
          .flatMap((teamId) => {
            const team = teamById.get(teamId);
            return team ? [team.name] : [];
          })
          .sort((left, right) => left.localeCompare(right)),
        catalogSource: catalogEntry?.source ?? null,
        isInCatalog: catalogEntry !== undefined,
        isOwnEnvironment: registration.environmentId === input.ownEnvironmentId,
      };
    })
    .sort(
      (left, right) =>
        Number(right.isOwnEnvironment) - Number(left.isOwnEnvironment) ||
        Number(right.registration.state === "active") -
          Number(left.registration.state === "active") ||
        (right.registration.lastSeenAt ?? -1) - (left.registration.lastSeenAt ?? -1) ||
        left.label.localeCompare(right.label),
    );
}

export function deriveRecentEnvironmentCommands(
  commands: ReadonlyArray<EnvironmentCommandRecord>,
  environmentId: EnvironmentId,
  limit = 20,
): ReadonlyArray<EnvironmentCommandRecord> {
  return commands
    .filter((command) => command.targetEnvironmentId === environmentId)
    .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
    .slice(0, limit);
}

function resultSummary(result: EnvironmentCommandResult): string {
  switch (result.kind) {
    case "startThread":
      return `Created thread ${result.threadId}`;
    case "sendMessage":
      return result.turnId === null
        ? `Message accepted in ${result.threadId}`
        : `Created turn ${result.turnId}`;
    case "interrupt":
      return `Interrupted thread ${result.threadId}`;
    case "statusQuery":
      return result.activeTurnId === null
        ? `Thread is ${result.sessionStatus}`
        : `Thread is ${result.sessionStatus} · active turn ${result.activeTurnId}`;
  }
}

export function environmentCommandSummary(command: EnvironmentCommandRecord): string {
  if (command.error !== null) return command.error;
  if (command.result !== null) return resultSummary(command.result);
  if (command.state === "pending") return "Waiting for the environment to claim it";
  if (command.state === "claimed") return "Claimed by the environment";
  if (command.state === "canceled") return "Canceled before it was claimed";
  if (command.state === "expired") return "Expired before completion";
  if (command.state === "failed") return "The environment reported a failure";
  return "Completed without a result pointer";
}

export function deleteConfirmationSecondsRemaining(
  armedUntil: number | null,
  now: number,
): number | null {
  if (armedUntil === null || armedUntil <= now) return null;
  return Math.ceil((armedUntil - now) / 1_000);
}

export function resolveDeleteConfirmationClick(
  armedUntil: number | null,
  now: number,
  confirmationDurationMs: number,
): { readonly confirmed: boolean; readonly armedUntil: number | null } {
  if (deleteConfirmationSecondsRemaining(armedUntil, now) !== null) {
    return { confirmed: true, armedUntil: null };
  }
  return { confirmed: false, armedUntil: now + confirmationDurationMs };
}
