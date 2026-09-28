import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http";
import { RpcTest } from "effect/unstable/rpc";
import { AuthOrchestrationReadScope, EnvironmentId } from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import { AppleRpcs, APPLE_WS_METHODS, type AppleIntegration } from "@spiritdevs/contracts/apple";
import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { resolveAppleCaller } from "../auth/appleCaller.ts";
import { CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AppleRuntime, type AppleBackend } from "./AppleRuntime.ts";
import { makeAppleRpcLayer } from "./appleRpc.ts";

const makeAuthLayer = () => {
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "pathway-apple-rpc-test-" });
  return EnvironmentAuth.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        config,
        SqlitePersistenceMemory,
        ServerSecretStore.layer.pipe(Layer.provide(config)),
      ),
    ),
  );
};
const target = {
  companyId: CompanyId.make("01990000-0000-7000-8000-000000000011"),
  accountId: "account",
  teamId: "APPLETEAM1",
};
const integration: AppleIntegration = {
  accountId: target.accountId,
  teamId: target.teamId,
  accountRevision: 1,
  revision: 0,
  connected: false,
  issuerId: null,
  keyIdSuffix: null,
  lastVerifiedAt: null,
};

it.layer(NodeServices.layer)("Apple RPC session identity", (it) => {
  for (const kind of [
    "owner-bearer",
    "peer-ticket",
    "unknown-ticket",
    "unverified-request",
  ] as const) {
    it.effect(`uses the authenticated ${kind} caller`, () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        yield* secrets.set(CLOUD_LINKED_USER_ID, new TextEncoder().encode("owner-clerk-subject"));
        const subject =
          kind === "owner-bearer"
            ? "cloud-connect"
            : kind === "peer-ticket"
              ? "peer-cloud-user-id"
              : "one-time-token";
        const grant = yield* auth.createPairingLink({
          subject,
          scopes: [AuthOrchestrationReadScope],
          ...(kind === "peer-ticket"
            ? { initiatingEnvironmentId: EnvironmentId.make("peer-env") }
            : {}),
        });
        const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
          grant.credential,
          undefined,
          { deviceType: "unknown" },
        );
        const bearer = HttpServerRequest.fromWeb(
          new Request("https://environment.test/ws", {
            headers: { authorization: `Bearer ${token.access_token}` },
          }),
        );
        const session = yield* auth.authenticateHttpRequest(bearer);
        const ticket = yield* auth.issueWebSocketTicket(session);
        const request =
          kind === "owner-bearer"
            ? bearer
            : HttpServerRequest.fromWeb(
                new Request(`https://environment.test/ws?wsTicket=${ticket.ticket}`),
              );
        // The WS route verifies the exact request before constructing any RPC layers.
        if (kind !== "unverified-request") yield* auth.authenticateWebSocketUpgrade(request);
        const authenticate = vi.spyOn(auth, "authenticateWebSocketUpgrade");
        const backend: AppleBackend = {
          authorizeCaller: vi.fn(async () => null),
          status: vi.fn(async () => ({ integration, environments: [] })),
          accountStatus: vi.fn(async () => ({})),
          heartbeat: vi.fn(async () => {
            throw new Error("Unexpected credential access");
          }),
          credential: vi.fn(async () => {
            throw new Error("Unexpected credential access");
          }),
          health: vi.fn(async () => null),
        };
        const runtime = new AppleRuntime({ backend, environmentId: "env" });
        yield* Effect.addFinalizer(() => Effect.sync(() => runtime.dispose()));
        const response = yield* Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(AppleRpcs);
          return yield* Effect.result(client[APPLE_WS_METHODS.status](target));
        }).pipe(
          Effect.provide(makeAppleRpcLayer(runtime, session.scopes)),
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        );
        expect(authenticate).not.toHaveBeenCalled();
        if (kind === "unknown-ticket" || kind === "unverified-request") {
          expect(response).toMatchObject({ _tag: "Failure", failure: { code: "forbidden" } });
          expect(backend.authorizeCaller).not.toHaveBeenCalled();
          expect(backend.status).not.toHaveBeenCalled();
        } else {
          expect(response).toMatchObject({ _tag: "Success", success: { integration } });
          expect(backend.authorizeCaller).toHaveBeenCalledTimes(2);
          expect(backend.authorizeCaller).toHaveBeenCalledWith({
            companyId: target.companyId,
            accountId: target.accountId,
            manage: false,
            caller:
              kind === "owner-bearer"
                ? { clerkSubject: "owner-clerk-subject" }
                : { userId: "peer-cloud-user-id" },
          });
        }
      }).pipe(Effect.provide(makeAuthLayer())),
    );
  }
  it.effect("fails closed when an owner session has no linked Cloud identity", () =>
    Effect.gen(function* () {
      expect(yield* resolveAppleCaller({ subject: "cloud-connect" })).toBeNull();
    }).pipe(Effect.provide(makeAuthLayer())),
  );
});
