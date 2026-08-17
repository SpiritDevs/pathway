import {
  CloudProjectSyncEntity,
  EnvironmentBindingEntity,
  EnvironmentRegistrationEntity,
  type EnvironmentBindingEntity as EnvironmentBinding,
  type EnvironmentRegistrationEntity as EnvironmentRegistration,
} from "@spiritdevs/client-runtime/sync";
import type { EnvironmentId, ProjectId } from "@spiritdevs/contracts";
import * as Schema from "effect/Schema";

import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";

const isCloudProject = Schema.is(CloudProjectSyncEntity);
const isEnvironmentBinding = Schema.is(EnvironmentBindingEntity);
const isEnvironmentRegistration = Schema.is(EnvironmentRegistrationEntity);

export interface ProjectConnectionMetadata {
  readonly environmentId: EnvironmentId;
  readonly localProjectId: ProjectId;
  readonly environmentLabel: string;
  readonly directory: string | null;
  readonly bindingStatus: EnvironmentBinding["status"] | null;
  readonly isPreferred: boolean;
  readonly lastSeenAt: number | null;
  readonly platform: EnvironmentRegistration["descriptor"]["platform"] | null;
  readonly serverVersion: string | null;
}

export interface ProjectConnectionCatalog {
  readonly bindings: ReadonlyArray<EnvironmentBinding>;
  readonly registrations: ReadonlyMap<EnvironmentId, EnvironmentRegistration>;
  readonly preferredBindingIds: ReadonlySet<string>;
}

/** Indexes the Convex replica once before project rows read it. */
export function buildProjectConnectionCatalog(
  replicaValues: Iterable<unknown>,
): ProjectConnectionCatalog {
  const catalog = {
    bindings: [] as EnvironmentBinding[],
    registrations: new Map<EnvironmentId, EnvironmentRegistration>(),
    preferredBindingIds: new Set<string>(),
  };

  for (const value of replicaValues) {
    if (isEnvironmentBinding(value)) {
      catalog.bindings.push(value);
    } else if (isEnvironmentRegistration(value)) {
      catalog.registrations.set(value.environmentId, value);
    } else if (isCloudProject(value) && value.preferredBindingId !== null) {
      catalog.preferredBindingIds.add(value.preferredBindingId);
    }
  }
  return catalog;
}

/** Joins environment-local project shells with their Convex binding and machine metadata. */
export function deriveProjectConnectionMetadata(input: {
  readonly members: ReadonlyArray<SidebarProjectGroupMember>;
  readonly catalog: ProjectConnectionCatalog;
}): ReadonlyArray<ProjectConnectionMetadata> {
  const memberByLocalRef = new Map(
    input.members.map((member) => [`${member.environmentId}:${member.id}`, member] as const),
  );
  const cloudProjectIds = new Set(
    input.catalog.bindings
      .filter(
        (binding) =>
          binding.status !== "revoked" &&
          memberByLocalRef.has(`${binding.environmentId}:${binding.localProjectId}`),
      )
      .map((binding) => binding.cloudProjectId),
  );
  const connectedBindings = input.catalog.bindings.filter(
    (binding) => binding.status !== "revoked" && cloudProjectIds.has(binding.cloudProjectId),
  );
  const boundLocalRefs = new Set(
    connectedBindings.map((binding) => `${binding.environmentId}:${binding.localProjectId}`),
  );
  const fromBinding = connectedBindings.map((binding): ProjectConnectionMetadata => {
    const member = memberByLocalRef.get(`${binding.environmentId}:${binding.localProjectId}`);
    const registration = input.catalog.registrations.get(binding.environmentId) ?? null;
    return {
      environmentId: binding.environmentId,
      localProjectId: binding.localProjectId,
      environmentLabel:
        registration?.descriptor.label ?? member?.environmentLabel ?? "Unknown environment",
      directory: binding.localWorkspaceRoot,
      bindingStatus: binding.status,
      isPreferred: input.catalog.preferredBindingIds.has(binding.id),
      lastSeenAt: binding.lastSeenAt ?? registration?.lastSeenAt ?? null,
      platform: registration?.descriptor.platform ?? null,
      serverVersion: registration?.descriptor.serverVersion ?? null,
    };
  });
  const localOnly = input.members
    .filter((member) => !boundLocalRefs.has(`${member.environmentId}:${member.id}`))
    .map((member): ProjectConnectionMetadata => {
      const registration = input.catalog.registrations.get(member.environmentId) ?? null;
      return {
        environmentId: member.environmentId,
        localProjectId: member.id,
        environmentLabel:
          registration?.descriptor.label ?? member.environmentLabel ?? "This machine",
        directory: member.workspaceRoot,
        bindingStatus: null,
        isPreferred: false,
        lastSeenAt: registration?.lastSeenAt ?? null,
        platform: registration?.descriptor.platform ?? null,
        serverVersion: registration?.descriptor.serverVersion ?? null,
      };
    });

  return [...fromBinding, ...localOnly].sort(
    (left, right) =>
      Number(right.isPreferred) - Number(left.isPreferred) ||
      left.environmentLabel.localeCompare(right.environmentLabel),
  );
}

export function projectConnectionPlatformLabel(
  platform: ProjectConnectionMetadata["platform"],
): string | null {
  if (platform === null) return null;
  const os =
    platform.os === "darwin"
      ? "macOS"
      : platform.os === "windows"
        ? "Windows"
        : platform.os === "linux"
          ? "Linux"
          : "Unknown OS";
  return `${os} · ${platform.arch}`;
}
