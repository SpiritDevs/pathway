import { EnvironmentId } from "@spiritdevs/contracts";
import { EnvironmentRegistrationId } from "@spiritdevs/contracts/cloudProject";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { EnvironmentRegistrationEntity } from "../sync/companyDomain.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import {
  effectiveConnectionCatalogChanges,
  mergeEffectiveConnectionCatalog,
  type CompanyRegistryReplicaState,
} from "./effectiveCatalog.ts";
import { BearerConnectionTarget } from "./model.ts";

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const REGISTRY_ENVIRONMENT_ID = EnvironmentId.make("environment-registry");
const OWN_ENVIRONMENT_ID = EnvironmentId.make("environment-own");

const LOCAL_ENTRY: ConnectionCatalogEntry = {
  target: new BearerConnectionTarget({
    environmentId: LOCAL_ENVIRONMENT_ID,
    label: "Locally configured",
    connectionId: "local-connection",
  }),
  profile: Option.none(),
};

function registration(input: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly lastSeenAt: number | null;
}) {
  return Schema.decodeUnknownSync(EnvironmentRegistrationEntity)({
    entityKind: "environmentRegistration",
    id: EnvironmentRegistrationId.make(`registration-${input.environmentId}`),
    environmentId: input.environmentId,
    publicKeyThumbprint: "thumbprint",
    descriptor: {
      environmentId: input.environmentId,
      label: input.label,
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "2026.8.0",
      capabilities: { repositoryIdentity: true },
    },
    relayLinkState: "linked",
    managedEndpointAvailable: true,
    lastSeenAt: input.lastSeenAt,
    serviceRoleIds: [],
    teamIds: [],
    state: "active",
    registeredByMembershipId: null,
    createdAt: 1_000,
    updatedAt: 2_000,
  });
}

function replica(...registrations: ReadonlyArray<ReturnType<typeof registration>>) {
  return {
    view: new Map(registrations.map((entry) => [entry.id, entry])),
  } satisfies CompanyRegistryReplicaState;
}

describe("effective connection catalog", () => {
  it("is local-only with no registry replica or an empty replica", () => {
    const localEntries = new Map([[LOCAL_ENVIRONMENT_ID, LOCAL_ENTRY]]);
    for (const registryReplica of [null, replica()]) {
      const merged = mergeEffectiveConnectionCatalog({
        localEntries,
        replica: registryReplica,
      });
      expect([...merged.keys()]).toEqual([LOCAL_ENVIRONMENT_ID]);
      expect(merged.get(LOCAL_ENVIRONMENT_ID)).toMatchObject({
        source: "local",
        target: LOCAL_ENTRY.target,
        profile: LOCAL_ENTRY.profile,
      });
    }
  });

  it("adds registry-only environments as relay targets with freshness", () => {
    const merged = mergeEffectiveConnectionCatalog({
      localEntries: new Map(),
      replica: replica(
        registration({
          environmentId: REGISTRY_ENVIRONMENT_ID,
          label: "Company environment",
          lastSeenAt: 12_345,
        }),
      ),
    });

    expect(merged.get(REGISTRY_ENVIRONMENT_ID)).toMatchObject({
      source: "companyRegistry",
      target: {
        _tag: "RelayConnectionTarget",
        environmentId: REGISTRY_ENVIRONMENT_ID,
        label: "Company environment",
      },
      freshness: { lastSeenAt: 12_345 },
    });
  });

  it("prefers same-id local configuration and fills only missing freshness", () => {
    const discovered = registration({
      environmentId: LOCAL_ENVIRONMENT_ID,
      label: "Registry label",
      lastSeenAt: 12_345,
    });
    const merged = mergeEffectiveConnectionCatalog({
      localEntries: new Map([[LOCAL_ENVIRONMENT_ID, LOCAL_ENTRY]]),
      replica: replica(discovered),
    });

    expect(merged.get(LOCAL_ENVIRONMENT_ID)).toMatchObject({
      source: "local",
      target: LOCAL_ENTRY.target,
      freshness: { lastSeenAt: 12_345 },
    });

    const localFreshness = { ...LOCAL_ENTRY, freshness: { lastSeenAt: 99_999 } };
    const locallyFresh = mergeEffectiveConnectionCatalog({
      localEntries: new Map([[LOCAL_ENVIRONMENT_ID, localFreshness]]),
      replica: replica(discovered),
    });
    expect(locallyFresh.get(LOCAL_ENVIRONMENT_ID)?.freshness).toEqual({ lastSeenAt: 99_999 });
  });

  it("excludes the device's own environment from registry-derived targets", () => {
    const merged = mergeEffectiveConnectionCatalog({
      localEntries: new Map(),
      replica: replica(
        registration({
          environmentId: OWN_ENVIRONMENT_ID,
          label: "This device",
          lastSeenAt: 12_345,
        }),
      ),
      currentEnvironmentId: OWN_ENVIRONMENT_ID,
    });

    expect(merged.has(OWN_ENVIRONMENT_ID)).toBe(false);
  });

  it.effect("publishes replica updates through the existing SubscriptionRef stream", () =>
    Effect.gen(function* () {
      const localEntries = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
      >(new Map([[LOCAL_ENVIRONMENT_ID, LOCAL_ENTRY]]));
      const registryReplica = yield* SubscriptionRef.make<CompanyRegistryReplicaState>(replica());
      const update = yield* Effect.forkChild(
        effectiveConnectionCatalogChanges({
          localEntries,
          replica: registryReplica,
        }).pipe(
          Stream.filter((entries) => entries.has(REGISTRY_ENVIRONMENT_ID)),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        ),
      );

      yield* SubscriptionRef.set(
        registryReplica,
        replica(
          registration({
            environmentId: REGISTRY_ENVIRONMENT_ID,
            label: "Added later",
            lastSeenAt: 54_321,
          }),
        ),
      );

      expect((yield* Fiber.join(update)).get(REGISTRY_ENVIRONMENT_ID)).toMatchObject({
        source: "companyRegistry",
        freshness: { lastSeenAt: 54_321 },
      });
    }),
  );
});
