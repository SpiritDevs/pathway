import {
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type CompanyRegistryReplicaState,
} from "@spiritdevs/client-runtime/connection";
import type { EnvironmentRegistrationEntity } from "@spiritdevs/client-runtime/sync";
import { EnvironmentId } from "@spiritdevs/contracts";
import { EnvironmentRegistrationId } from "@spiritdevs/contracts/cloudProject";
import { CompanyId } from "@spiritdevs/contracts/company";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { effectiveCatalogState } from "./catalog";

const LOCAL = EnvironmentId.make("environment-local");
const REMOTE_A = EnvironmentId.make("environment-a");
const REMOTE_B = EnvironmentId.make("environment-b");
const MANUAL = EnvironmentId.make("environment-manual");
const COMPANY_A = CompanyId.make("company-a");
const COMPANY_B = CompanyId.make("company-b");

const registration = (environmentId: EnvironmentId): EnvironmentRegistrationEntity => ({
  entityKind: "environmentRegistration",
  id: EnvironmentRegistrationId.make(`registration-${environmentId}`),
  environmentId,
  publicKeyThumbprint: `thumbprint-${environmentId}`,
  descriptor: {
    environmentId,
    label: environmentId,
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "2026.8.0",
    capabilities: { repositoryIdentity: true },
  },
  relayLinkState: "linked",
  managedEndpointAvailable: true,
  lastSeenAt: 1_000,
  serviceRoleIds: [],
  teamIds: [],
  state: "active",
  registeredByMembershipId: null,
  createdAt: 1_000,
  updatedAt: 1_000,
});

const replica = (entity: EnvironmentRegistrationEntity): CompanyRegistryReplicaState => ({
  view: new Map([[entity.id, entity]]),
});

describe("effectiveCatalogState", () => {
  it("keeps local operational rows while using only the supplied company replicas", () => {
    const local = {
      isReady: true,
      entries: new Map([
        [
          LOCAL,
          {
            source: "local" as const,
            target: new PrimaryConnectionTarget({
              environmentId: LOCAL,
              label: "This machine",
              httpBaseUrl: "http://127.0.0.1:3773",
              wsBaseUrl: "ws://127.0.0.1:3773",
            }),
            profile: Option.none(),
          },
        ],
        [
          REMOTE_B,
          {
            source: "local" as const,
            target: new RelayConnectionTarget({ environmentId: REMOTE_B, label: "Persisted B" }),
            profile: Option.none(),
          },
        ],
        [
          MANUAL,
          {
            source: "local" as const,
            target: new RelayConnectionTarget({ environmentId: MANUAL, label: "Manual relay" }),
            profile: Option.none(),
          },
        ],
      ]),
    };
    const replicas = new Map([
      [COMPANY_A, replica(registration(REMOTE_A))],
      [COMPANY_B, replica(registration(REMOTE_B))],
    ]);

    expect(
      effectiveCatalogState(local, new Map([[COMPANY_A, replicas.get(COMPANY_A)!]]), replicas)
        .entries,
    ).toEqual(
      new Map([
        [LOCAL, local.entries.get(LOCAL)!],
        [MANUAL, local.entries.get(MANUAL)!],
        [
          REMOTE_A,
          expect.objectContaining({
            source: "companyRegistry",
            target: expect.objectContaining({ environmentId: REMOTE_A }),
          }),
        ],
      ]),
    );
    const allCompanies = effectiveCatalogState(local, replicas, replicas).entries;
    expect(allCompanies.has(REMOTE_B)).toBe(true);
    expect(allCompanies.get(REMOTE_B)?.source).toBe("local");
  });
});
