import { api } from "@spiritdevs/backend/convexApi";
import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
  RelayDeviceRegistrationRequest,
  RelayEnvironmentLinkProofPayload,
  RelayEnvironmentLinkRequest,
  RelayManagedEndpoint,
} from "@spiritdevs/contracts/relay";
import { getFunctionName, type FunctionReference } from "convex/server";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect, it } from "@effect/vitest";

import * as AgentActivityRows from "../agentActivity/AgentActivityRows.ts";
import * as DeliveryAttempts from "../agentActivity/DeliveryAttempts.ts";
import * as Devices from "../agentActivity/Devices.ts";
import * as LiveActivities from "../agentActivity/LiveActivities.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import { RelayConvexClient, RelayConvexClientError } from "../db.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "../environments/ManagedEndpointAllocations.ts";
import * as ManagedTunnelLimits from "../environments/ManagedTunnelLimits.ts";

const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, bytes) => Effect.succeed(bytes),
  }),
);

function clientLayer(input: {
  readonly query?: (
    args: unknown,
    reference: string,
  ) => Effect.Effect<unknown, RelayConvexClientError>;
  readonly mutation?: (
    args: unknown,
    reference: string,
  ) => Effect.Effect<unknown, RelayConvexClientError>;
}) {
  return Layer.succeed(
    RelayConvexClient,
    RelayConvexClient.of({
      query: (reference: unknown, args: unknown) =>
        input.query?.(args, functionName(reference)) ?? Effect.die("unexpected query"),
      mutation: (reference: unknown, args: unknown) =>
        input.mutation?.(args, functionName(reference)) ?? Effect.die("unexpected mutation"),
    } as unknown as RelayConvexClient["Service"]),
  );
}

function functionName(reference: unknown): string {
  return getFunctionName(reference as FunctionReference<"query" | "mutation">);
}

function failingClient(operation: "query" | "mutation") {
  const cause = new RelayConvexClientError({ operation, cause: new Error("offline") });
  return {
    cause,
    layer: clientLayer({
      query: () => Effect.fail(cause),
      mutation: () => Effect.fail(cause),
    }),
  };
}

const activityState = {
  environmentId: "env-one" as RelayAgentActivityState["environmentId"],
  threadId: "thread-one" as RelayAgentActivityState["threadId"],
  projectTitle: "Pathway",
  threadTitle: "Build",
  phase: "running",
  headline: "Working",
  modelTitle: "Codex",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deepLink: "pathway://thread/thread-one",
} satisfies RelayAgentActivityState;

const deviceRegistration = {
  deviceId: "device-one" as RelayDeviceRegistrationRequest["deviceId"],
  label: "Phone",
  platform: "ios",
  iosMajorVersion: 19,
  appVersion: "1.2.3" as RelayDeviceRegistrationRequest["appVersion"],
  bundleId: "com.spiritdevs.pathway" as RelayDeviceRegistrationRequest["bundleId"],
  apsEnvironment: "sandbox",
  pushToken: "push-token" as RelayDeviceRegistrationRequest["pushToken"],
  pushToStartToken: "push-to-start-token" as RelayDeviceRegistrationRequest["pushToStartToken"],
  preferences: {
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
} satisfies RelayDeviceRegistrationRequest;

const linkRequest = {
  deviceId: "device-one" as RelayEnvironmentLinkRequest["deviceId"],
  proof: "compact-proof",
  notificationsEnabled: true,
  liveActivitiesEnabled: false,
  managedTunnelsEnabled: true,
} satisfies RelayEnvironmentLinkRequest;

const linkProof = {
  iss: "pathway-env:env-one",
  aud: "https://relay.example.test",
  sub: "env-one",
  jti: "proof-one",
  iat: 0,
  exp: 300,
  challenge: "challenge",
  environmentId: "env-one" as RelayEnvironmentLinkProofPayload["environmentId"],
  descriptor: {
    environmentId: "env-one" as RelayEnvironmentLinkProofPayload["environmentId"],
    label: "Studio",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "1.0.0",
    capabilities: { repositoryIdentity: true },
  },
  environmentPublicKey: "public-key",
  endpoint: {
    httpBaseUrl: "https://studio.example.test/",
    wsBaseUrl: "wss://studio.example.test/ws",
    providerKind: "manual",
  },
  origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
  scopes: ["agent_activity_notifications", "managed_tunnels"],
} satisfies RelayEnvironmentLinkProofPayload;

const managedEndpoint = {
  httpBaseUrl: "https://managed.example.test/",
  wsBaseUrl: "wss://managed.example.test/ws",
  providerKind: "cloudflare_tunnel",
} satisfies RelayManagedEndpoint;

const aggregate = {
  title: "Pathway",
  subtitle: "Agent work in progress",
  activeCount: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
  activities: [
    {
      environmentId:
        "env-one" as RelayAgentActivityAggregateState["activities"][number]["environmentId"],
      threadId: "thread-one" as RelayAgentActivityAggregateState["activities"][number]["threadId"],
      projectTitle: "Pathway",
      threadTitle: "Build",
      modelTitle: "Codex",
      phase: "running",
      status: "Working",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deepLink: "pathway://thread/thread-one",
    },
  ],
} satisfies RelayAgentActivityAggregateState;

describe("Convex relay repositories", () => {
  it.effect("maps environment-link query results to the branded service boundary", () => {
    const layer = EnvironmentLinks.layer.pipe(
      Layer.provide(
        clientLayer({
          query: () =>
            Effect.succeed([
              {
                environmentId: "env-one",
                label: "Studio",
                endpoint: {
                  httpBaseUrl: "https://studio.example.test",
                  wsBaseUrl: "wss://studio.example.test/ws",
                  providerKind: "cloudflare_tunnel",
                },
                linkedAt: "2026-01-01T00:00:00.000Z",
              },
            ]),
        }),
      ),
    );
    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      expect(yield* links.listForUser({ userId: "user-one" })).toMatchObject([
        { environmentId: "env-one", label: "Studio" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes device registration through one atomic Convex mutation", () => {
    let received: unknown;
    const layer = Devices.layer.pipe(
      Layer.provide(
        clientLayer({
          mutation: (args) => {
            received = args;
            return Effect.succeed(null);
          },
        }),
      ),
    );
    return Effect.gen(function* () {
      const devices = yield* Devices.Devices;
      yield* devices.register({
        userId: "user-one",
        registration: {
          deviceId: "device-one",
          label: "Phone",
          platform: "ios",
          iosMajorVersion: 19,
          preferences: {
            notificationsEnabled: true,
            liveActivitiesEnabled: true,
            notifyOnApproval: true,
            notifyOnInput: true,
            notifyOnCompletion: true,
            notifyOnFailure: true,
          },
        },
      });
      expect(received).toMatchObject({
        userId: "user-one",
        registration: { deviceId: "device-one" },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("transforms Convex live-activity targets into the legacy APNs row shape", () => {
    const layer = LiveActivities.layer.pipe(
      Layer.provide(
        clientLayer({
          query: () =>
            Effect.succeed([
              {
                userId: "user-one",
                deviceId: "device-one",
                platform: "ios",
                iosMajorVersion: 19,
                appVersion: null,
                bundleId: null,
                apsEnvironment: "sandbox",
                pushToken: "push-token",
                pushToStartToken: null,
                preferences: { notificationsEnabled: true },
                activityPushToken: null,
                remoteStartQueuedAt: null,
                remoteStartedAt: null,
                endedAt: null,
                lastAggregate: null,
                lastLiveActivityDeliveryAt: null,
              },
            ]),
        }),
      ),
    );
    return Effect.gen(function* () {
      const live = yield* LiveActivities.LiveActivities;
      const rows = yield* live.listTargets({ userId: "user-one" });
      expect(rows[0]).toMatchObject({
        user_id: "user-one",
        device_id: "device-one",
        preferences_json: '{"notificationsEnabled":true}',
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("returns the authenticated credential principal from Convex", () => {
    const convex = clientLayer({
      query: () =>
        Effect.succeed({
          credentialId: "credential-one",
          environmentId: "env-one",
          environmentPublicKey: "public-key",
        }),
    });
    const layer = EnvironmentCredentials.layer.pipe(
      Layer.provide(Layer.merge(convex, cryptoLayer)),
    );
    return Effect.gen(function* () {
      const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
      const principal = yield* credentials.authenticate("credential-token");
      expect(Option.getOrNull(principal)).toMatchObject({ environmentId: "env-one" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("surfaces the authoritative atomic reservation limit result", () => {
    const layer = ManagedEndpointAllocations.layer.pipe(
      Layer.provide(
        clientLayer({
          mutation: () =>
            Effect.succeed({ status: "limit_exceeded", maxTunnels: 3, activeTunnels: 3 }),
        }),
      ),
    );
    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const error = yield* Effect.flip(
        allocations.reserve({
          userId: "user-one",
          environmentId: "env-four",
          hostname: "env-four.example.test",
          tunnelName: "env-four",
        }),
      );
      expect(error).toMatchObject({ _tag: "ManagedTunnelLimitExceeded", activeTunnels: 3 });
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps the advisory capacity query to the existing domain error", () => {
    const layer = ManagedTunnelLimits.layer.pipe(
      Layer.provide(
        clientLayer({
          query: () => Effect.succeed({ allowed: false, maxTunnels: 3, activeTunnels: 3 }),
        }),
      ),
    );
    return Effect.gen(function* () {
      const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
      const error = yield* Effect.flip(
        limits.ensureCapacity({ userId: "user-one", environmentId: "env-four" }),
      );
      expect(error).toMatchObject({ _tag: "ManagedTunnelLimitExceeded", maxTunnels: 3 });
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes agent activity state to Convex with a creation timestamp", () => {
    let received: unknown;
    const layer = AgentActivityRows.layer.pipe(
      Layer.provide(
        clientLayer({
          mutation: (args) => {
            received = args;
            return Effect.succeed(null);
          },
        }),
      ),
    );
    return Effect.gen(function* () {
      const rows = yield* AgentActivityRows.AgentActivityRows;
      yield* rows.upsert({
        environmentPublicKey: "public-key",
        state: {
          environmentId: "env-one" as never,
          threadId: "thread-one" as never,
          projectTitle: "Pathway",
          threadTitle: "Build",
          phase: "running",
          headline: "Working",
          modelTitle: "Codex",
          updatedAt: "2026-01-01T00:00:00.000Z",
          deepLink: "pathway://thread/thread-one",
        },
      });
      expect(received).toMatchObject({
        environmentPublicKey: "public-key",
        state: { phase: "running" },
      });
      expect(received).toHaveProperty("createdAt");
    }).pipe(Effect.provide(layer));
  });

  it.effect("adds the delivery claim lease boundary inside the adapter", () => {
    let received: unknown;
    const layer = DeliveryAttempts.layer.pipe(
      Layer.provide(
        Layer.merge(
          clientLayer({
            mutation: (args) => {
              received = args;
              return Effect.succeed("claimed");
            },
          }),
          cryptoLayer,
        ),
      ),
    );
    return Effect.gen(function* () {
      const attempts = yield* DeliveryAttempts.DeliveryAttempts;
      expect(
        yield* attempts.claimSourceJob({
          userId: "user-one",
          environmentId: "env-one",
          threadId: "thread-one",
          deviceId: "device-one",
          kind: "push_notification",
          sourceJobId: "job-one",
          token: "push-token",
        }),
      ).toBe("claimed");
      expect(received).toHaveProperty("leaseExpiresBefore");
    }).pipe(Effect.provide(layer));
  });

  it.effect("returns false when Convex rejects a replayed DPoP nonce", () => {
    const layer = DpopProofs.layer.pipe(
      Layer.provide(clientLayer({ mutation: () => Effect.succeed(false) })),
    );
    return Effect.gen(function* () {
      const replay = yield* DpopProofs.DpopProofReplay;
      expect(
        yield* replay.consume({
          thumbprint: "thumbprint",
          jti: "nonce",
          iat: 0,
          expiresAt: DateTime.makeUnsafe(300_000),
        }),
      ).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("routes every environment-link operation through its Convex function", () => {
    const calls: Array<{ readonly reference: unknown; readonly args: unknown }> = [];
    const convex = clientLayer({
      query: (args, reference) => {
        calls.push({ reference, args });
        if (reference === functionName(api.relayPersistence.listUsersForEnvironment)) {
          return Effect.succeed(["user-one"]);
        }
        if (reference === functionName(api.relayPersistence.listDeliveryUsersForEnvironment)) {
          return Effect.succeed([
            {
              userId: "user-one",
              notificationsEnabled: true,
              liveActivitiesEnabled: false,
            },
          ]);
        }
        if (reference === functionName(api.relayPersistence.listPublicKeysForEnvironment)) {
          return Effect.succeed(["public-key"]);
        }
        if (reference === functionName(api.relayPersistence.listEnvironmentLinksForUser)) {
          return Effect.succeed([
            {
              environmentId: "env-one",
              label: "Studio",
              endpoint: managedEndpoint,
              linkedAt: "2026-01-01T00:00:00.000Z",
            },
          ]);
        }
        return Effect.succeed({
          environmentId: "env-one",
          label: "Studio",
          endpoint: managedEndpoint,
          environmentPublicKey: "public-key",
          linkedAt: "2026-01-01T00:00:00.000Z",
        });
      },
      mutation: (args, reference) => {
        calls.push({ reference, args });
        return Effect.succeed(
          reference === functionName(api.relayPersistence.revokeEnvironmentLink),
        );
      },
    });
    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      yield* links.upsert({
        userId: "user-one",
        request: linkRequest,
        proof: linkProof,
        endpoint: managedEndpoint,
      });
      expect(yield* links.listUsersForEnvironment({ environmentId: "env-one" })).toEqual([
        "user-one",
      ]);
      expect(
        yield* links.listDeliveryUsersForEnvironment({
          environmentId: "env-one",
          environmentPublicKey: "public-key",
        }),
      ).toEqual([
        {
          userId: "user-one",
          notificationsEnabled: true,
          liveActivitiesEnabled: false,
        },
      ]);
      expect(yield* links.listPublicKeysForEnvironment({ environmentId: "env-one" })).toEqual([
        "public-key",
      ]);
      expect(yield* links.listForUser({ userId: "user-one" })).toHaveLength(1);
      expect(
        yield* links.getForUser({ userId: "user-one", environmentId: "env-one" }),
      ).toMatchObject({ environmentPublicKey: "public-key" });
      expect(yield* links.revokeForUser({ userId: "user-one", environmentId: "env-one" })).toBe(
        true,
      );

      expect(calls.map(({ reference }) => reference)).toEqual([
        functionName(api.relayPersistence.upsertEnvironmentLink),
        functionName(api.relayPersistence.listUsersForEnvironment),
        functionName(api.relayPersistence.listDeliveryUsersForEnvironment),
        functionName(api.relayPersistence.listPublicKeysForEnvironment),
        functionName(api.relayPersistence.listEnvironmentLinksForUser),
        functionName(api.relayPersistence.getEnvironmentLinkForUser),
        functionName(api.relayPersistence.revokeEnvironmentLink),
      ]);
      expect(calls[0]?.args).toMatchObject({
        userId: "user-one",
        environmentId: "env-one",
        environmentLabel: "Studio",
        endpointHttpBaseUrl: managedEndpoint.httpBaseUrl,
        endpointWsBaseUrl: managedEndpoint.wsBaseUrl,
        endpointProviderKind: "cloudflare_tunnel",
        createdByDeviceId: "device-one",
        now: "1970-01-01T00:00:00.000Z",
      });
      expect(calls[6]?.args).toMatchObject({ now: "1970-01-01T00:00:00.000Z" });
    }).pipe(Effect.provide(EnvironmentLinks.layer.pipe(Layer.provide(convex))));
  });

  it.effect("maps environment-link client failures to operation-specific domain errors", () => {
    const failure = failingClient("mutation");
    return Effect.gen(function* () {
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      const upsertError = yield* Effect.flip(
        links.upsert({
          userId: "user-one",
          request: linkRequest,
          proof: linkProof,
          endpoint: managedEndpoint,
        }),
      );
      expect(upsertError).toMatchObject({
        _tag: "EnvironmentLinkUpsertPersistenceError",
        userId: "user-one",
        environmentId: "env-one",
        cause: failure.cause,
      });
      const revokeError = yield* Effect.flip(
        links.revokeForUser({ userId: "user-one", environmentId: "env-one" }),
      );
      expect(revokeError).toMatchObject({
        _tag: "EnvironmentLinkRevokePersistenceError",
        cause: failure.cause,
      });
    }).pipe(Effect.provide(EnvironmentLinks.layer.pipe(Layer.provide(failure.layer))));
  });

  it.effect("creates, replaces, authenticates, and revokes credentials through Convex", () => {
    const calls: Array<{ readonly reference: unknown; readonly args: unknown }> = [];
    const convex = clientLayer({
      query: (args, reference) => {
        calls.push({ reference, args });
        return Effect.succeed({
          credentialId: "credential-one",
          environmentId: "env-one",
          environmentPublicKey: "public-key",
        });
      },
      mutation: (args, reference) => {
        calls.push({ reference, args });
        return Effect.succeed(
          reference === functionName(api.relayPersistence.revokeEnvironmentCredentialsForPublicKey),
        );
      },
    });
    const layer = EnvironmentCredentials.layer.pipe(
      Layer.provide(Layer.merge(convex, cryptoLayer)),
    );
    return Effect.gen(function* () {
      const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
      expect(
        yield* credentials.create({
          environmentId: "env-one",
          environmentPublicKey: "public-key",
        }),
      ).toMatch(/^pathwayenv_/u);
      expect(
        yield* credentials.replaceLinkAndCreate({
          userId: "user-one",
          request: linkRequest,
          proof: linkProof,
          endpoint: managedEndpoint,
        }),
      ).toMatch(/^pathwayenv_/u);
      expect(
        Option.getOrNull(yield* credentials.authenticate("pathwayenv_credential_secret")),
      ).toEqual({
        credentialId: "credential-one",
        environmentId: "env-one",
        environmentPublicKey: "public-key",
      });
      expect(
        yield* credentials.revokeForEnvironmentPublicKey({
          environmentId: "env-one",
          environmentPublicKey: "public-key",
        }),
      ).toBe(true);

      expect(calls.map(({ reference }) => reference)).toEqual([
        functionName(api.relayPersistence.insertEnvironmentCredential),
        functionName(api.relayPersistence.replaceEnvironmentLinkAndCredential),
        functionName(api.relayPersistence.authenticateEnvironmentCredential),
        functionName(api.relayPersistence.revokeEnvironmentCredentialsForPublicKey),
      ]);
      expect(calls[1]?.args).toMatchObject({
        userId: "user-one",
        environmentId: "env-one",
        environmentLabel: "Studio",
        endpointHttpBaseUrl: managedEndpoint.httpBaseUrl,
        endpointWsBaseUrl: managedEndpoint.wsBaseUrl,
        credentialId: expect.any(String),
        credentialHash: expect.any(String),
        now: "1970-01-01T00:00:00.000Z",
      });
      expect(calls[2]?.args).toEqual({
        credentialHash: Buffer.from("pathwayenv_credential_secret").toString("base64url"),
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps credential Convex failures to the correct lifecycle stage", () => {
    const failure = failingClient("mutation");
    const layer = EnvironmentCredentials.layer.pipe(
      Layer.provide(Layer.merge(failure.layer, cryptoLayer)),
    );
    return Effect.gen(function* () {
      const credentials = yield* EnvironmentCredentials.EnvironmentCredentials;
      const createError = yield* Effect.flip(
        credentials.create({ environmentId: "env-one", environmentPublicKey: "public-key" }),
      );
      expect(createError).toMatchObject({
        _tag: "EnvironmentCredentialCreatePersistenceError",
        stage: "insert-credential",
        environmentId: "env-one",
        cause: failure.cause,
      });
      const revokeError = yield* Effect.flip(
        credentials.revokeForEnvironmentPublicKey({
          environmentId: "env-one",
          environmentPublicKey: "public-key",
        }),
      );
      expect(revokeError).toMatchObject({
        _tag: "EnvironmentCredentialRevokePersistenceError",
        cause: failure.cause,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("routes the complete agent-activity row lifecycle through Convex", () => {
    const calls: Array<{ readonly reference: unknown; readonly args: unknown }> = [];
    const convex = clientLayer({
      query: (args, reference) => {
        calls.push({ reference, args });
        return Effect.succeed(
          reference === functionName(api.relayPersistence.getAgentActivityRowForUserThread)
            ? activityState
            : [activityState],
        );
      },
      mutation: (args, reference) => {
        calls.push({ reference, args });
        return Effect.succeed(
          reference === functionName(api.relayPersistence.pruneTerminalAgentActivityRows)
            ? 2
            : null,
        );
      },
    });
    return Effect.gen(function* () {
      const rows = yield* AgentActivityRows.AgentActivityRows;
      yield* rows.upsert({ environmentPublicKey: "public-key", state: activityState });
      yield* rows.remove({
        environmentId: "env-one",
        environmentPublicKey: "public-key",
        threadId: "thread-one",
      });
      yield* rows.pruneTerminal({ updatedBefore: "2026-01-02T00:00:00.000Z" });
      expect(yield* rows.listForUser({ userId: "user-one" })).toEqual([activityState]);
      expect(
        yield* rows.getForUserThread({
          userId: "user-one",
          environmentId: "env-one",
          threadId: "thread-one",
        }),
      ).toEqual(activityState);

      expect(calls.map(({ reference }) => reference)).toEqual([
        functionName(api.relayPersistence.upsertAgentActivityRow),
        functionName(api.relayPersistence.removeAgentActivityRow),
        functionName(api.relayPersistence.pruneTerminalAgentActivityRows),
        functionName(api.relayPersistence.listAgentActivityRowsForUser),
        functionName(api.relayPersistence.getAgentActivityRowForUserThread),
      ]);
      expect(calls[0]?.args).toMatchObject({
        environmentPublicKey: "public-key",
        state: activityState,
        createdAt: "1970-01-01T00:00:00.000Z",
      });
      expect(calls[2]?.args).toEqual({
        updatedBefore: "2026-01-02T00:00:00.000Z",
        limit: AgentActivityRows.AGENT_ACTIVITY_PRUNE_BATCH_SIZE,
      });
    }).pipe(Effect.provide(AgentActivityRows.layer.pipe(Layer.provide(convex))));
  });

  it.effect("preserves activity identifiers when Convex row persistence fails", () => {
    const failure = failingClient("mutation");
    return Effect.gen(function* () {
      const rows = yield* AgentActivityRows.AgentActivityRows;
      const error = yield* Effect.flip(
        rows.upsert({ environmentPublicKey: "public-key", state: activityState }),
      );
      expect(error).toMatchObject({
        _tag: "AgentActivityRowUpsertPersistenceError",
        environmentId: "env-one",
        threadId: "thread-one",
        cause: failure.cause,
      });
    }).pipe(Effect.provide(AgentActivityRows.layer.pipe(Layer.provide(failure.layer))));
  });

  it.effect("maps delivery record, claim, and completion payloads to Convex", () => {
    const calls: Array<{ readonly reference: unknown; readonly args: unknown }> = [];
    const convex = clientLayer({
      mutation: (args, reference) => {
        calls.push({ reference, args });
        return Effect.succeed(
          reference === functionName(api.relayPersistence.claimDeliverySourceJob)
            ? "claimed"
            : null,
        );
      },
    });
    const layer = DeliveryAttempts.layer.pipe(Layer.provide(Layer.merge(convex, cryptoLayer)));
    const input = {
      userId: "user-one",
      environmentId: "env-one",
      threadId: "thread-one",
      deviceId: "device-one",
      kind: "push_notification",
      sourceJobId: "job-one",
      token: "token-with-secret-suffix",
      apnsStatus: 200,
    } as const;
    return Effect.gen(function* () {
      const attempts = yield* DeliveryAttempts.DeliveryAttempts;
      yield* attempts.record(input);
      expect(yield* attempts.claimSourceJob(input)).toBe("claimed");
      yield* attempts.completeSourceJob({
        sourceJobId: "job-one",
        apnsStatus: 200,
        apnsId: "apns-one",
      });

      expect(calls.map(({ reference }) => reference)).toEqual([
        functionName(api.relayPersistence.recordDeliveryAttempt),
        functionName(api.relayPersistence.claimDeliverySourceJob),
        functionName(api.relayPersistence.completeDeliverySourceJob),
      ]);
      expect(calls[0]?.args).toMatchObject({
        userId: "user-one",
        sourceJobId: "job-one",
        tokenSuffix: "t-suffix",
        createdAt: "1970-01-01T00:00:00.000Z",
        apnsReason: null,
        apnsId: null,
        transportError: null,
      });
      expect(calls[1]?.args).toMatchObject({
        sourceJobId: "job-one",
        leaseExpiresBefore: "1969-12-31T23:50:00.000Z",
      });
      expect(calls[2]?.args).toEqual({
        sourceJobId: "job-one",
        completedAt: "1970-01-01T00:00:00.000Z",
        apnsStatus: 200,
        apnsReason: null,
        apnsId: "apns-one",
        transportError: null,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("identifies the delivery operation that failed in Convex", () => {
    const failure = failingClient("mutation");
    const layer = DeliveryAttempts.layer.pipe(
      Layer.provide(Layer.merge(failure.layer, cryptoLayer)),
    );
    return Effect.gen(function* () {
      const attempts = yield* DeliveryAttempts.DeliveryAttempts;
      const error = yield* Effect.flip(
        attempts.completeSourceJob({ sourceJobId: "job-one", transportError: "timeout" }),
      );
      expect(error).toMatchObject({
        _tag: "DeliveryAttemptRecordPersistenceError",
        operation: "complete-source-job",
        sourceJobId: "job-one",
        cause: failure.cause,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("routes device register, unregister, and safe listing through Convex", () => {
    const calls: Array<{ readonly reference: unknown; readonly args: unknown }> = [];
    const listed = {
      deviceId: "device-one",
      label: "Phone",
      platform: "ios" as const,
      iosMajorVersion: 19,
      appVersion: "1.2.3",
      notifications: {
        enabled: true,
        notifyOnApproval: true,
        notifyOnInput: true,
        notifyOnCompletion: true,
        notifyOnFailure: true,
      },
      liveActivities: { enabled: true },
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const convex = clientLayer({
      query: (args, reference) => {
        calls.push({ reference, args });
        return Effect.succeed([listed]);
      },
      mutation: (args, reference) => {
        calls.push({ reference, args });
        return Effect.succeed(null);
      },
    });
    return Effect.gen(function* () {
      const devices = yield* Devices.Devices;
      yield* devices.register({ userId: "user-one", registration: deviceRegistration });
      yield* devices.unregister({ userId: "user-one", deviceId: "device-one" });
      expect(yield* devices.listForUser({ userId: "user-one" })).toEqual([listed]);

      expect(calls.map(({ reference }) => reference)).toEqual([
        functionName(api.relayPersistence.registerDevice),
        functionName(api.relayPersistence.unregisterDevice),
        functionName(api.relayPersistence.listDevices),
      ]);
      expect(calls[0]?.args).toEqual({
        userId: "user-one",
        now: "1970-01-01T00:00:00.000Z",
        registration: deviceRegistration,
      });
      expect(calls[1]?.args).toEqual({ userId: "user-one", deviceId: "device-one" });
    }).pipe(Effect.provide(Devices.layer.pipe(Layer.provide(convex))));
  });

  it.effect("maps device Convex failures without losing user and device context", () => {
    const failure = failingClient("mutation");
    return Effect.gen(function* () {
      const devices = yield* Devices.Devices;
      const error = yield* Effect.flip(
        devices.register({ userId: "user-one", registration: deviceRegistration }),
      );
      expect(error).toMatchObject({
        _tag: "DeviceRegistrationPersistenceError",
        stage: "upsert-device",
        userId: "user-one",
        deviceId: "device-one",
        cause: failure.cause,
      });
    }).pipe(Effect.provide(Devices.layer.pipe(Layer.provide(failure.layer))));
  });

  it.effect("routes every Live Activity state transition through Convex", () => {
    const calls: Array<{ readonly reference: unknown; readonly args: unknown }> = [];
    const convex = clientLayer({
      query: (args, reference) => {
        calls.push({ reference, args });
        return Effect.succeed([]);
      },
      mutation: (args, reference) => {
        calls.push({ reference, args });
        return Effect.succeed(null);
      },
    });
    return Effect.gen(function* () {
      const live = yield* LiveActivities.LiveActivities;
      yield* live.register({
        userId: "user-one",
        registration: {
          deviceId: "device-one" as never,
          activityPushToken: "activity-token" as never,
        },
      });
      expect(yield* live.listTargets({ userId: "user-one" })).toEqual([]);
      yield* live.markDelivery({
        userId: "user-one",
        deviceId: "device-one",
        kind: "live_activity_update",
        aggregate,
        deliveredAt: "2026-01-01T00:01:00.000Z",
      });
      yield* live.markStartQueued({
        userId: "user-one",
        deviceId: "device-one",
        queuedAt: "2026-01-01T00:00:30.000Z",
      });
      yield* live.clearStartQueued({ userId: "user-one", deviceId: "device-one" });
      yield* live.invalidateDeliveryToken({
        userId: "user-one",
        deviceId: "device-one",
        kind: "live_activity_update",
        invalidatedAt: "2026-01-01T00:02:00.000Z",
      });

      expect(calls.map(({ reference }) => reference)).toEqual([
        functionName(api.relayPersistence.registerLiveActivity),
        functionName(api.relayPersistence.listLiveActivityTargets),
        functionName(api.relayPersistence.markLiveActivityDelivery),
        functionName(api.relayPersistence.markLiveActivityStartQueued),
        functionName(api.relayPersistence.clearLiveActivityStartQueued),
        functionName(api.relayPersistence.invalidateLiveActivityDeliveryToken),
      ]);
      expect(calls[0]?.args).toEqual({
        userId: "user-one",
        deviceId: "device-one",
        activityPushToken: "activity-token",
        now: "1970-01-01T00:00:00.000Z",
      });
      expect(calls[2]?.args).toMatchObject({ aggregate });
    }).pipe(Effect.provide(LiveActivities.layer.pipe(Layer.provide(convex))));
  });

  it.effect("maps Live Activity Convex failures to the requested transition", () => {
    const failure = failingClient("mutation");
    return Effect.gen(function* () {
      const live = yield* LiveActivities.LiveActivities;
      const error = yield* Effect.flip(
        live.invalidateDeliveryToken({
          userId: "user-one",
          deviceId: "device-one",
          kind: "live_activity_end",
          invalidatedAt: "2026-01-01T00:02:00.000Z",
        }),
      );
      expect(error).toMatchObject({
        _tag: "LiveActivityDeliveryMarkPersistenceError",
        operation: "invalidate-delivery-token",
        userId: "user-one",
        deviceId: "device-one",
        kind: "live_activity_end",
        cause: failure.cause,
      });
    }).pipe(Effect.provide(LiveActivities.layer.pipe(Layer.provide(failure.layer))));
  });

  it.effect("maps DPoP consume and bounded pruning to Convex", () => {
    const calls: Array<{ readonly reference: unknown; readonly args: unknown }> = [];
    const convex = clientLayer({
      mutation: (args, reference) => {
        calls.push({ reference, args });
        return Effect.succeed(
          reference === functionName(api.relayPersistence.consumeDpopProof) ? true : 4,
        );
      },
    });
    return Effect.gen(function* () {
      const replay = yield* DpopProofs.DpopProofReplay;
      expect(
        yield* replay.consume({
          thumbprint: "thumbprint",
          jti: "nonce-one",
          iat: 0,
          expiresAt: DateTime.makeUnsafe(300_000),
        }),
      ).toBe(true);
      yield* replay.pruneExpired;
      expect(calls.map(({ reference }) => reference)).toEqual([
        functionName(api.relayPersistence.consumeDpopProof),
        functionName(api.relayPersistence.pruneExpiredDpopProofs),
      ]);
      expect(calls[0]?.args).toEqual({
        thumbprint: "thumbprint",
        jti: "nonce-one",
        iat: 0,
        expiresAt: "1970-01-01T00:05:00.000Z",
        createdAt: "1970-01-01T00:00:00.000Z",
      });
      expect(calls[1]?.args).toEqual({
        expiresBefore: "1970-01-01T00:00:00.000Z",
        limit: DpopProofs.DPOP_PROOF_PRUNE_BATCH_SIZE,
      });
    }).pipe(Effect.provide(DpopProofs.layer.pipe(Layer.provide(convex))));
  });

  it.effect("maps DPoP Convex failures to replay persistence errors", () => {
    const failure = failingClient("mutation");
    return Effect.gen(function* () {
      const replay = yield* DpopProofs.DpopProofReplay;
      const error = yield* Effect.flip(
        replay.consume({
          thumbprint: "thumbprint",
          jti: "nonce-one",
          iat: 0,
          expiresAt: DateTime.makeUnsafe(300_000),
        }),
      );
      expect(error).toMatchObject({
        _tag: "DpopProofReplayPersistenceError",
        operation: "consume",
        thumbprint: "thumbprint",
        jti: "nonce-one",
        cause: failure.cause,
      });
    }).pipe(Effect.provide(DpopProofs.layer.pipe(Layer.provide(failure.layer))));
  });

  it.effect("routes every managed endpoint allocation transition through Convex", () => {
    const allocation = {
      userId: "user-one",
      environmentId: "env-one",
      hostname: "env-one.example.test",
      tunnelId: "tunnel-one",
      tunnelName: "env-one",
      dnsRecordId: "dns-one",
      readyAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "generation-one",
    };
    const calls: Array<{ readonly reference: unknown; readonly args: unknown }> = [];
    const convex = clientLayer({
      query: (args, reference) => {
        calls.push({ reference, args });
        return Effect.succeed(allocation);
      },
      mutation: (args, reference) => {
        calls.push({ reference, args });
        if (reference === functionName(api.relayPersistence.reserveManagedEndpointAllocation)) {
          return Effect.succeed({ status: "reserved", allocation });
        }
        if (reference === functionName(api.relayPersistence.claimManagedEndpointRelease)) {
          return Effect.succeed(true);
        }
        if (reference === functionName(api.relayPersistence.claimManagedEndpointDeprovision)) {
          return Effect.succeed("claim-generation");
        }
        if (
          reference === functionName(api.relayPersistence.removeClaimedManagedEndpointAllocation)
        ) {
          return Effect.succeed(true);
        }
        return Effect.succeed(null);
      },
    });
    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      expect(yield* allocations.get({ userId: "user-one", environmentId: "env-one" })).toEqual(
        allocation,
      );
      expect(
        yield* allocations.reserve({
          userId: "user-one",
          environmentId: "env-one",
          hostname: "env-one.example.test",
          tunnelName: "env-one",
        }),
      ).toEqual(allocation);
      yield* allocations.recordTunnel({
        userId: "user-one",
        environmentId: "env-one",
        tunnelId: "tunnel-one",
      });
      yield* allocations.recordDns({
        userId: "user-one",
        environmentId: "env-one",
        dnsRecordId: "dns-one",
      });
      yield* allocations.markReady({ userId: "user-one", environmentId: "env-one" });
      expect(
        yield* allocations.claimRelease({
          userId: "user-one",
          environmentId: "env-one",
          tunnelId: "tunnel-one",
          updatedAt: "generation-one",
        }),
      ).toBe(true);
      expect(
        yield* allocations.claimDeprovision({
          userId: "user-one",
          environmentId: "env-one",
          updatedAt: "generation-one",
        }),
      ).toBe("claim-generation");
      yield* allocations.remove({ userId: "user-one", environmentId: "env-one" });
      expect(
        yield* allocations.removeClaimed({
          userId: "user-one",
          environmentId: "env-one",
          updatedAt: "claim-generation",
        }),
      ).toBe(true);

      expect(calls.map(({ reference }) => reference)).toEqual([
        functionName(api.relayPersistence.getManagedEndpointAllocation),
        functionName(api.relayPersistence.reserveManagedEndpointAllocation),
        functionName(api.relayPersistence.recordManagedEndpointTunnel),
        functionName(api.relayPersistence.recordManagedEndpointDns),
        functionName(api.relayPersistence.markManagedEndpointReady),
        functionName(api.relayPersistence.claimManagedEndpointRelease),
        functionName(api.relayPersistence.claimManagedEndpointDeprovision),
        functionName(api.relayPersistence.removeManagedEndpointAllocation),
        functionName(api.relayPersistence.removeClaimedManagedEndpointAllocation),
      ]);
      expect(calls[5]?.args).toEqual({
        userId: "user-one",
        environmentId: "env-one",
        tunnelId: "tunnel-one",
        updatedAt: "generation-one",
        claimedAt: "1970-01-01T00:00:00.000Z",
      });
      expect(calls[6]?.args).toEqual({
        userId: "user-one",
        environmentId: "env-one",
        updatedAt: "generation-one",
        claimedAt: "1970-01-01T00:00:00.000Z",
      });
    }).pipe(Effect.provide(ManagedEndpointAllocations.layer.pipe(Layer.provide(convex))));
  });

  it.effect("maps managed endpoint Convex failures with operation context", () => {
    const failure = failingClient("mutation");
    return Effect.gen(function* () {
      const allocations = yield* ManagedEndpointAllocations.ManagedEndpointAllocations;
      const error = yield* Effect.flip(
        allocations.recordTunnel({
          userId: "user-one",
          environmentId: "env-one",
          tunnelId: "tunnel-one",
        }),
      );
      expect(error).toMatchObject({
        _tag: "ManagedEndpointAllocationPersistenceError",
        operation: "record-tunnel",
        stage: "database-request",
        userId: "user-one",
        environmentId: "env-one",
        tunnelId: "tunnel-one",
        cause: failure.cause,
      });
    }).pipe(Effect.provide(ManagedEndpointAllocations.layer.pipe(Layer.provide(failure.layer))));
  });

  it.effect("passes advisory tunnel capacity and maps Convex failures", () => {
    const allowedLayer = ManagedTunnelLimits.layer.pipe(
      Layer.provide(
        clientLayer({
          query: (args, reference) => {
            expect(reference).toBe(functionName(api.relayPersistence.ensureManagedTunnelCapacity));
            expect(args).toEqual({ userId: "user-one", environmentId: "env-one" });
            return Effect.succeed({ allowed: true, maxTunnels: 3, activeTunnels: 2 });
          },
        }),
      ),
    );
    const failure = failingClient("query");
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
        yield* limits.ensureCapacity({ userId: "user-one", environmentId: "env-one" });
      }).pipe(Effect.provide(allowedLayer));
      const error = yield* Effect.gen(function* () {
        const limits = yield* ManagedTunnelLimits.ManagedTunnelLimits;
        return yield* Effect.flip(
          limits.ensureCapacity({ userId: "user-one", environmentId: "env-one" }),
        );
      }).pipe(Effect.provide(ManagedTunnelLimits.layer.pipe(Layer.provide(failure.layer))));
      expect(error).toMatchObject({
        _tag: "ManagedTunnelLimitPersistenceError",
        operation: "count-tunnels",
        userId: "user-one",
        cause: failure.cause,
      });
    });
  });
});
