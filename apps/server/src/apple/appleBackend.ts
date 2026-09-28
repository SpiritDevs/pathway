import { api } from "@spiritdevs/backend/convexApi";
import { AppleIntegration, AppleEnvironmentHealth } from "@spiritdevs/contracts/apple";
import { appleFailure } from "@spiritdevs/backend/appStoreConnectApi";
import { ConvexHttpClient } from "convex/browser";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { makeCloudSyncTokenProvider, resolveCloudSyncConfig } from "../cloud/syncDaemon.ts";
import { getOrCreateCloudSyncDpopKeyPairFromSecretStore } from "../cloud/environmentKeys.ts";
import { convexErrorCode, type ConvexServiceTokenProvider } from "../cloud/convexServiceToken.ts";
import { AppleRuntime, type AppleBackend } from "./AppleRuntime.ts";

const decodeIntegration = Schema.decodeUnknownSync(AppleIntegration);
const decodeHealth = Schema.decodeUnknownSync(Schema.Array(AppleEnvironmentHealth));

/** Each call owns its client so concurrent requests cannot overwrite another call's bearer. */
export function makeAppleBackend(
  convexUrl: string,
  tokens: ConvexServiceTokenProvider,
): AppleBackend {
  async function call<A>(run: (client: ConvexHttpClient) => Promise<A>): Promise<A> {
    const token = await Effect.runPromise(tokens.token);
    const client = new ConvexHttpClient(convexUrl);
    client.setAuth(token);
    try {
      return await run(client);
    } catch (error) {
      if (convexErrorCode(error) !== "not-authenticated") throw error;
      await Effect.runPromise(tokens.invalidate(token));
      client.setAuth(await Effect.runPromise(tokens.token));
      return await run(client);
    }
  }
  const targetArgs = (input: { companyId: string; accountId: string; teamId: string }) => ({
    companyId: input.companyId,
    accountId: input.accountId,
    teamId: input.teamId,
  });
  return {
    accountStatus: (input) =>
      call((client) =>
        client.query(api.appleIntegrations.accountStatus, {
          companyId: input.companyId,
          accountId: input.accountId,
        }),
      ),
    status: async (target) => {
      const result = await call((client) =>
        client.query(api.appleIntegrations.status, targetArgs(target)),
      );
      return {
        integration: decodeIntegration(result.integration),
        environments: decodeHealth(result.environments),
      };
    },
    heartbeat: async (target) => {
      const result = await call((client) =>
        client.mutation(api.appleIntegrations.heartbeat, targetArgs(target)),
      );
      return {
        integration: decodeIntegration(result.integration),
        expiresAt: result.expiresAt,
      };
    },
    credential: (target, revision, accountRevision) =>
      call((client) =>
        client.action(api.appleIntegrations.runtimeCredential, {
          ...targetArgs(target),
          revision,
          accountRevision,
        }),
      ),
    health: (target, accountRevision, health) =>
      call((client) =>
        client.mutation(api.appleIntegrations.updateHealth, {
          ...targetArgs(target),
          accountRevision,
          revision: health.revision,
          lastVerifiedAt: health.lastVerifiedAt,
          error: health.error,
        }),
      ),
  };
}

/** Initialization is shared by callers and retried after failure, only when Apple is used. */
function lazyBackend(initialize: () => Promise<AppleBackend>): AppleBackend {
  let pending: Promise<AppleBackend> | null = null;
  const get = () => {
    pending ??= initialize().catch((error: unknown) => {
      pending = null;
      throw error;
    });
    return pending;
  };
  return {
    accountStatus: async (input) => (await get()).accountStatus(input),
    status: async (target) => (await get()).status(target),
    heartbeat: async (target) => (await get()).heartbeat(target),
    credential: async (target, revision, accountRevision) =>
      (await get()).credential(target, revision, accountRevision),
    health: async (target, accountRevision, health) =>
      (await get()).health(target, accountRevision, health),
  };
}

/** Constructed once by the WS route, disposed with the server scope. No background network work. */
export const makeConfiguredAppleRuntime = Effect.fn("apple.runtime.make")(function* () {
  const config = yield* resolveCloudSyncConfig;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const unavailable = () =>
    Promise.reject(
      appleFailure(
        "cloud-unavailable",
        "Link this environment to Pathway Cloud before using Apple services.",
      ),
    );
  let backend: AppleBackend = {
    accountStatus: unavailable,
    status: unavailable,
    heartbeat: unavailable,
    credential: unavailable,
    health: unavailable,
  };
  if (config._tag === "Configured") {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const http = yield* HttpClient.HttpClient;
    const initialize = Effect.gen(function* () {
      const dpopKeys = yield* getOrCreateCloudSyncDpopKeyPairFromSecretStore(secrets);
      const tokens = yield* makeCloudSyncTokenProvider({ environmentId, secrets, dpopKeys });
      return makeAppleBackend(config.settings.convexUrl, tokens);
    }).pipe(Effect.provideService(HttpClient.HttpClient, http));
    backend = lazyBackend(() => Effect.runPromise(initialize));
  }
  const runtime = new AppleRuntime({ backend, environmentId });
  yield* Effect.addFinalizer(() => Effect.sync(() => runtime.dispose()));
  return runtime;
});
