/**
 * Whether this environment is registered with a company, and how it gets there.
 *
 * A registration is keyed by (company, environment) and every company-scoped write refuses an
 * environment the company never registered — adopting a local checkout into a company's issue
 * tracker is the one people meet first. The rules live here, apart from the sync runtime, so a
 * screen can wait for its own registration without importing (and therefore starting) the engine.
 *
 * @module cloud/environmentRegistration
 */
import type { CompanyRegistryReplicaState } from "@spiritdevs/client-runtime/connection";
import { EnvironmentRegistrationEntity, RoleEntity } from "@spiritdevs/client-runtime/sync";
import type { CompanyId } from "@spiritdevs/contracts/company";
import type { EnvironmentCloudRegistrationInfo, EnvironmentId } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PrimaryEnvironmentHttpClient } from "../environments/primary/httpClient";
import { runPrimaryHttp } from "../lib/runtime";
import type { EnvironmentControlClient } from "./environmentControl";

/** Narrows a replica entity to an environment registration. */
export const isEnvironmentRegistration = Schema.is(EnvironmentRegistrationEntity);
const isRole = Schema.is(RoleEntity);

const ENVIRONMENT_SERVICE_ROLE_PERMISSIONS = [
  "company.read",
  "projects.read",
  "issues.read",
  "workflow.manage",
  "environments.read",
] as const;

/**
 * Picks the least-privileged role that can back a new environment registration, or `null` when
 * this environment is already active or the company replica has not delivered a suitable role.
 */
export function automaticEnvironmentRegistrationServiceRoleId(
  values: Iterable<unknown>,
  environmentId: EnvironmentId,
): string | null {
  const roles: Array<RoleEntity> = [];
  for (const value of values) {
    if (
      isEnvironmentRegistration(value) &&
      value.environmentId === environmentId &&
      value.state === "active"
    ) {
      return null;
    }
    if (
      isRole(value) &&
      ENVIRONMENT_SERVICE_ROLE_PERMISSIONS.every((permission) =>
        value.permissions.includes(permission),
      )
    ) {
      roles.push(value);
    }
  }
  return (
    roles.toSorted((left, right) => left.permissions.length - right.permissions.length)[0]?.id ??
    null
  );
}

function capabilitiesMatch(
  left: EnvironmentCloudRegistrationInfo["descriptor"]["capabilities"],
  right: EnvironmentCloudRegistrationInfo["descriptor"]["capabilities"],
): boolean {
  const entries = (value: typeof left) =>
    Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries(left)) === JSON.stringify(entries(right));
}

export function environmentRegistrationMatchesInfo(
  registration: EnvironmentRegistrationEntity,
  info: EnvironmentCloudRegistrationInfo,
): boolean {
  const current = registration.descriptor;
  const incoming = info.descriptor;
  return (
    registration.state === "active" &&
    registration.publicKeyThumbprint === info.publicKeyThumbprint &&
    registration.relayLinkState === info.relayLinkState &&
    registration.managedEndpointAvailable === info.managedEndpointAvailable &&
    current.environmentId === incoming.environmentId &&
    current.label === incoming.label &&
    current.platform.os === incoming.platform.os &&
    current.platform.arch === incoming.platform.arch &&
    current.serverVersion === incoming.serverVersion &&
    capabilitiesMatch(current.capabilities, incoming.capabilities)
  );
}

/**
 * Publishes this environment's registration to one company, or reports that nothing was needed.
 *
 * Returns `false` — without a write — when the company already carries a matching active
 * registration, and when it carries neither a registration nor a role low-privileged enough to back
 * a new one.
 */
export async function registerEnvironmentAutomatically(input: {
  readonly companyId: CompanyId;
  readonly environmentId: EnvironmentId;
  readonly replica: CompanyRegistryReplicaState;
  readonly control: Pick<EnvironmentControlClient, "registerEnvironment">;
  readonly readRegistrationInfo: () => Promise<EnvironmentCloudRegistrationInfo>;
}): Promise<boolean> {
  const activeRegistration = Array.from(input.replica.view.values()).find(
    (value): value is EnvironmentRegistrationEntity =>
      isEnvironmentRegistration(value) &&
      value.environmentId === input.environmentId &&
      value.state === "active",
  );
  const serviceRoleId = automaticEnvironmentRegistrationServiceRoleId(
    input.replica.view.values(),
    input.environmentId,
  );
  if (activeRegistration === undefined && serviceRoleId === null) return false;
  const info = await input.readRegistrationInfo();
  if (
    activeRegistration !== undefined &&
    environmentRegistrationMatchesInfo(activeRegistration, info)
  ) {
    return false;
  }
  await input.control.registerEnvironment({
    companyId: input.companyId,
    info,
    serviceRoleIds:
      activeRegistration?.serviceRoleIds ?? (serviceRoleId === null ? [] : [serviceRoleId]),
  });
  return true;
}

/** This environment's own registration material, read from the server it is hosted by. */
export function readPrimaryEnvironmentRegistrationInfo(): Promise<EnvironmentCloudRegistrationInfo> {
  return runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.connect.registrationInfo({ headers: {} })),
    ),
  );
}
