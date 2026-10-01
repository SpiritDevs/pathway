import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http";
import { RpcTest } from "effect/unstable/rpc";
import {
  AuthOrchestrationReadScope,
  EnvironmentId,
  type AuthEnvironmentScope,
} from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import { AppleRpcs, APPLE_WS_METHODS, type AppleIntegration } from "@spiritdevs/contracts/apple";
import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { resolveAppleCaller } from "../auth/appleCaller.ts";
import { CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AppleRuntime, type AppleBackend } from "./AppleRuntime.ts";
import { AppleIdSession } from "./AppleIdSession.ts";
import { XcodeInstall } from "../xcode/XcodeInstall.ts";
import { makeXcodeRpcLayer } from "../xcode/xcodeRpc.ts";
import { XcodeRpcs } from "@spiritdevs/contracts/xcode";
import { makeAppleRpcLayer } from "./appleRpc.ts";

const makeTestServices = (runtime: AppleRuntime, scopes: readonly AuthEnvironmentScope[]) => {
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected session access");
  };
  const sessions = new AppleIdSession({
    status: unused,
    read: unused,
    save: unused,
    revoke: unused,
  });
  const xcode = new XcodeInstall(
    {
      supported: false,
      inspect: async () => ({
        host: "needs-mac",
        installed: [],
        available: [],
        runtimes: [],
        disk: { freeBytes: null, requiredBytes: 0 },
        error: null,
      }),
      needsAdmin: () => false,
      installPath: unused,
      run: unused,
    },
    { load: async () => null, save: unused },
  );
  return Layer.mergeAll(
    makeAppleRpcLayer(runtime, scopes, sessions),
    makeXcodeRpcLayer(xcode, runtime, scopes),
  );
};

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
          ...(kind === "owner-bearer" ? { clerkSubject: "owner-clerk-subject" } : {}),
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
          const xcode = yield* RpcTest.makeClient(XcodeRpcs);
          const xcodeResult = yield* Effect.result(xcode["xcode.status"](target));
          expect(xcodeResult).toMatchObject(
            kind === "unknown-ticket" || kind === "unverified-request"
              ? { _tag: "Failure", failure: { code: "forbidden" } }
              : { _tag: "Success", success: { host: "needs-mac" } },
          );
          return yield* Effect.result(client[APPLE_WS_METHODS.status](target));
        }).pipe(
          Effect.provide(makeTestServices(runtime, session.scopes)),
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        );
        expect(authenticate).not.toHaveBeenCalled();
        if (kind === "unknown-ticket" || kind === "unverified-request") {
          expect(response).toMatchObject({ _tag: "Failure", failure: { code: "forbidden" } });
          expect(backend.authorizeCaller).not.toHaveBeenCalled();
          expect(backend.status).not.toHaveBeenCalled();
        } else {
          expect(response).toMatchObject({ _tag: "Success", success: { integration } });
          expect(backend.authorizeCaller).toHaveBeenCalledTimes(4);
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
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      yield* secrets.set(CLOUD_LINKED_USER_ID, new TextEncoder().encode("owner-b"));
      expect(yield* resolveAppleCaller({ subject: "cloud-connect" })).toBeNull();
    }).pipe(Effect.provide(makeAuthLayer())),
  );
  it.effect("retains the mint identity when a grant is redeemed after owner relink", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      yield* secrets.set(CLOUD_LINKED_USER_ID, new TextEncoder().encode("owner-a"));
      const oldGrant = yield* auth.createPairingLink({
        subject: "cloud-connect",
        clerkSubject: "owner-a",
      });
      yield* secrets.remove(CLOUD_LINKED_USER_ID);
      yield* secrets.set(CLOUD_LINKED_USER_ID, new TextEncoder().encode("owner-b"));
      const newGrant = yield* auth.createPairingLink({
        subject: "cloud-connect",
        clerkSubject: "owner-b",
      });
      for (const [grant, expectedSubject] of [
        [oldGrant, "owner-a"],
        [newGrant, "owner-b"],
      ] as const) {
        const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
          grant.credential,
          undefined,
          { deviceType: "unknown" },
        );
        const request = HttpServerRequest.fromWeb(
          new Request("https://environment.test/ws", {
            headers: { authorization: `Bearer ${token.access_token}` },
          }),
        );
        const session = yield* auth.authenticateWebSocketUpgrade(request);
        expect(session.clerkSubject).toBe(expectedSubject);
        expect(yield* resolveAppleCaller(session)).toEqual(
          expectedSubject === "owner-b" ? { clerkSubject: "owner-b" } : null,
        );
        const reopenedStore = yield* SessionStore.make;
        expect((yield* reopenedStore.verify(token.access_token)).clerkSubject).toBe(
          expectedSubject,
        );
        const ticket = yield* auth.issueWebSocketTicket(session);
        expect((yield* reopenedStore.verifyWebSocketToken(ticket.ticket)).clerkSubject).toBe(
          expectedSubject,
        );
      }
    }).pipe(Effect.provide(makeAuthLayer())),
  );
  for (const transport of ["bearer", "browser-ticket"] as const) {
    it.effect(`denies an old owner's live ${transport} Apple session after owner relink`, () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        yield* secrets.set(CLOUD_LINKED_USER_ID, new TextEncoder().encode("owner-a"));
        const grant = yield* auth.createPairingLink({
          subject: "cloud-connect",
          clerkSubject: "owner-a",
          scopes: [AuthOrchestrationReadScope],
        });
        const request = yield* Effect.gen(function* () {
          if (transport === "bearer") {
            const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
              grant.credential,
              undefined,
              { deviceType: "unknown" },
            );
            return HttpServerRequest.fromWeb(
              new Request("https://environment.test/ws", {
                headers: { authorization: `Bearer ${token.access_token}` },
              }),
            );
          }
          const browser = yield* auth.createBrowserSession(grant.credential, {
            deviceType: "unknown",
          });
          const sessions = yield* SessionStore.SessionStore;
          const session = yield* auth.authenticateHttpRequest(
            HttpServerRequest.fromWeb(
              new Request("https://environment.test/", {
                headers: { cookie: `${sessions.cookieName}=${browser.sessionToken}` },
              }),
            ),
          );
          const ticket = yield* auth.issueWebSocketTicket(session);
          return HttpServerRequest.fromWeb(
            new Request(`https://environment.test/ws?wsTicket=${ticket.ticket}`),
          );
        });
        const session = yield* auth.authenticateWebSocketUpgrade(request);
        expect(session.clerkSubject).toBe("owner-a");
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
        yield* Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(AppleRpcs);
          const xcode = yield* RpcTest.makeClient(XcodeRpcs);
          yield* xcode["xcode.status"](target);
          yield* client[APPLE_WS_METHODS.status](target);
          expect(backend.authorizeCaller).toHaveBeenCalledWith(
            expect.objectContaining({ caller: { clerkSubject: "owner-a" } }),
          );
          vi.mocked(backend.authorizeCaller).mockClear();
          vi.mocked(backend.status).mockClear();
          yield* secrets.remove(CLOUD_LINKED_USER_ID);
          const unlinked = yield* Effect.result(client[APPLE_WS_METHODS.status](target));
          expect(unlinked).toMatchObject({ _tag: "Failure", failure: { code: "forbidden" } });
          yield* secrets.set(CLOUD_LINKED_USER_ID, new TextEncoder().encode("owner-b"));
          const relinked = yield* Effect.result(client[APPLE_WS_METHODS.status](target));
          expect(relinked).toMatchObject({ _tag: "Failure", failure: { code: "forbidden" } });
          expect(yield* Effect.result(xcode["xcode.status"](target))).toMatchObject({
            _tag: "Failure",
            failure: { code: "forbidden" },
          });
          expect(yield* resolveAppleCaller(session)).toBeNull();
          expect(backend.authorizeCaller).not.toHaveBeenCalled();
          expect(backend.status).not.toHaveBeenCalled();
        }).pipe(
          Effect.provide(makeTestServices(runtime, session.scopes)),
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        );
      }).pipe(Effect.provide(makeAuthLayer())),
    );
  }
});
