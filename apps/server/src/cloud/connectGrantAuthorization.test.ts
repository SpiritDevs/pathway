import { describe, expect, it } from "@effect/vitest";
import { EnvironmentHttpUnauthorizedError, EnvironmentId } from "@spiritdevs/contracts";
import { CompanyId, MembershipId, RoleAssignmentId, RoleId } from "@spiritdevs/contracts/company";
import { AuthorizationEpoch, CompanyVersion, SyncEntityId } from "@spiritdevs/contracts/cloudSync";
import type {
  RelayCloudMintCredentialProofPayload,
  RelayValidatedConnectGrantIdentity,
} from "@spiritdevs/contracts/relay";
import {
  EMPTY_STORED_SYNC_STATE,
  SYNC_BOOTSTRAP_GENERATION,
  SYNC_DOCUMENT_SCHEMA_VERSION,
  type StoredSyncEntity,
  type StoredSyncState,
} from "@spiritdevs/client-runtime/sync";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { requireCloudMintConnectGrantAuthorization } from "./http.ts";
import {
  authorizeConnectGrantFromLocalReplica,
  isConnectGrantAuthorizedByReplica,
  resolveConnectGrantActorFromLocalReplica,
  resolveConnectGrantActorFromReplica,
} from "./connectGrantAuthorization.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-connect-target");
const OTHER_ENVIRONMENT_ID = EnvironmentId.make("environment-connect-other");
const COMPANY_ID = CompanyId.make("company-connect-target");
const MEMBERSHIP_ID = MembershipId.make("membership-connect-user");
const ROLE_ID = RoleId.make("role-connect-controller");
const ASSIGNMENT_ID = RoleAssignmentId.make("assignment-connect-controller");

const connectGrant = (
  overrides: Partial<RelayValidatedConnectGrantIdentity> = {},
): RelayValidatedConnectGrantIdentity => ({
  environmentId: ENVIRONMENT_ID,
  membershipId: MEMBERSHIP_ID,
  permission: "remoteAgents.control",
  ...overrides,
});

const proof = (
  grant: RelayValidatedConnectGrantIdentity | undefined,
): RelayCloudMintCredentialProofPayload => ({
  iss: "https://relay.example.test",
  aud: `t3-env:${ENVIRONMENT_ID}`,
  sub: "cloud-user-connect",
  jti: "connect-proof-jti",
  iat: 1,
  exp: 60,
  environmentId: ENVIRONMENT_ID,
  clientProofKeyThumbprint: "client-proof-thumbprint",
  cnf: { jkt: "client-proof-thumbprint" },
  ...(grant === undefined ? {} : { connectGrant: grant }),
  nonce: "connect-proof-nonce",
  scope: ["environment:connect"],
});

const entity = (
  entityKind: StoredSyncEntity["entityKind"],
  entityId: string,
  payload: unknown,
): StoredSyncEntity => ({
  entityKind,
  entityId: SyncEntityId.make(entityId),
  version: CompanyVersion.make(1),
  payload,
});

function replica(
  input: {
    readonly membershipState?: "active" | "locked" | "left";
    readonly permissions?: ReadonlyArray<string>;
    readonly bootstrapped?: boolean;
    readonly includeMembership?: boolean;
  } = {},
): StoredSyncState {
  return {
    ...EMPTY_STORED_SYNC_STATE,
    checkpoint: {
      schemaVersion: SYNC_DOCUMENT_SCHEMA_VERSION,
      bootstrapGeneration: SYNC_BOOTSTRAP_GENERATION,
      companyId: COMPANY_ID,
      cursor: CompanyVersion.make(1),
      authorizationEpoch: AuthorizationEpoch.make(1),
      bootstrapped: input.bootstrapped ?? true,
    },
    entities: [
      entity("company", COMPANY_ID, {
        id: COMPANY_ID,
        name: "Connect target",
        issueKeyPrefix: "CNT",
        lifecycleState: "active",
        deletionScheduledAt: null,
        purgeAfter: null,
        owners: [],
        createdAt: 1,
        updatedAt: 1,
      }),
      ...(input.includeMembership === false
        ? []
        : [
            entity("membership", MEMBERSHIP_ID, {
              id: MEMBERSHIP_ID,
              userId: "cloud-user-connect",
              state: input.membershipState ?? "active",
              displayNameSnapshot: "Connect User",
              emailSnapshot: "connect@example.test",
              invitedByMembershipId: null,
              joinedAt: 1,
              createdAt: 1,
              updatedAt: 1,
            }),
          ]),
      entity("role", ROLE_ID, {
        id: ROLE_ID,
        name: "Controller",
        description: "Can control remote agents",
        permissions: input.permissions ?? ["remoteAgents.control"],
        seeded: false,
        createdAt: 1,
        updatedAt: 1,
      }),
      entity("roleAssignment", ASSIGNMENT_ID, {
        id: ASSIGNMENT_ID,
        membershipId: MEMBERSHIP_ID,
        roleId: ROLE_ID,
        scope: { kind: "company" },
        createdAt: 1,
      }),
    ],
  };
}

function authorizeAgainst(localReplica: StoredSyncState) {
  return {
    authorizeConnectGrant: (input: {
      readonly environmentId: EnvironmentId;
      readonly connectGrant: RelayValidatedConnectGrantIdentity;
    }) =>
      Effect.succeed(
        isConnectGrantAuthorizedByReplica({
          ...input,
          replica: localReplica,
        }),
      ),
  };
}

function expectAuthorizationRefused<R>(
  effect: Effect.Effect<void, EnvironmentHttpUnauthorizedError, R>,
) {
  return Effect.gen(function* () {
    const error = yield* Effect.flip(effect);
    expect(error).toMatchObject({
      _tag: "EnvironmentHttpUnauthorizedError",
      message: "Invalid cloud mint request.",
    });
  });
}

describe("cloud mint connect-grant authorization", () => {
  it("resolves the grant membership's user only after the replica authorizes it", () => {
    expect(
      resolveConnectGrantActorFromReplica({
        environmentId: ENVIRONMENT_ID,
        connectGrant: connectGrant(),
        replica: replica(),
      }),
    ).toBe("cloud-user-connect");
    expect(
      resolveConnectGrantActorFromReplica({
        environmentId: ENVIRONMENT_ID,
        connectGrant: connectGrant(),
        replica: replica({ includeMembership: false }),
      }),
    ).toBeNull();
  });

  it.effect("accepts a grant when the replica has an active membership with the permission", () =>
    requireCloudMintConnectGrantAuthorization(
      authorizeAgainst(replica()),
      proof(connectGrant()),
      ENVIRONMENT_ID,
    ),
  );

  it.effect("refuses a grant when the replica membership is inactive", () =>
    expectAuthorizationRefused(
      requireCloudMintConnectGrantAuthorization(
        authorizeAgainst(replica({ membershipState: "locked" })),
        proof(connectGrant()),
        ENVIRONMENT_ID,
      ),
    ),
  );

  it.effect("refuses a grant when the replica does not grant the permission", () =>
    expectAuthorizationRefused(
      requireCloudMintConnectGrantAuthorization(
        authorizeAgainst(replica({ permissions: ["remoteAgents.dispatch"] })),
        proof(connectGrant()),
        ENVIRONMENT_ID,
      ),
    ),
  );

  it.effect("refuses a grant for a different target environment", () =>
    expectAuthorizationRefused(
      requireCloudMintConnectGrantAuthorization(
        authorizeAgainst(replica()),
        proof(connectGrant({ environmentId: OTHER_ENVIRONMENT_ID })),
        ENVIRONMENT_ID,
      ),
    ),
  );

  it.effect("refuses a grant when the replica is empty or not bootstrapped", () =>
    Effect.gen(function* () {
      yield* expectAuthorizationRefused(
        requireCloudMintConnectGrantAuthorization(
          authorizeAgainst(EMPTY_STORED_SYNC_STATE),
          proof(connectGrant()),
          ENVIRONMENT_ID,
        ),
      );
      yield* expectAuthorizationRefused(
        requireCloudMintConnectGrantAuthorization(
          authorizeAgainst(replica({ bootstrapped: false })),
          proof(connectGrant()),
          ENVIRONMENT_ID,
        ),
      );
    }),
  );

  it.effect("refuses a grant when cloud sync is disabled", () =>
    Effect.gen(function* () {
      yield* expectAuthorizationRefused(
        requireCloudMintConnectGrantAuthorization(
          { authorizeConnectGrant: authorizeConnectGrantFromLocalReplica },
          proof(connectGrant()),
          ENVIRONMENT_ID,
        ),
      );
      expect(
        yield* resolveConnectGrantActorFromLocalReplica({
          environmentId: ENVIRONMENT_ID,
          connectGrant: connectGrant(),
        }),
      ).toBeNull();
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
          Layer.succeed(
            SqlClient.SqlClient,
            SqlClient.SqlClient.of({} as Parameters<typeof SqlClient.SqlClient.of>[0]),
          ),
        ),
      ),
    ),
  );

  it.effect("leaves a proof without a connect grant on the device-local path", () =>
    Effect.gen(function* () {
      let calls = 0;
      yield* requireCloudMintConnectGrantAuthorization(
        {
          authorizeConnectGrant: () =>
            Effect.sync(() => {
              calls += 1;
              return false;
            }),
        },
        proof(undefined),
        ENVIRONMENT_ID,
      );
      expect(calls).toBe(0);
    }),
  );
});
