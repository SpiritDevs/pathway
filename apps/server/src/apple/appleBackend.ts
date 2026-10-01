import { ReleaseRuntime, type ReleaseBackend, releaseTarget } from "../releases/ReleaseRuntime.ts";
import { ReleaseAccess } from "../releases/ReleaseAccess.ts";
import { MacReleaseHost, releaseError } from "../releases/ReleaseHost.ts";
import { fileReleaseStore } from "../releases/ReleaseStore.ts";
import { ReleaseIntent } from "@spiritdevs/contracts/releases";
import { HostProcessPlatform, HostProcessArchitecture } from "@spiritdevs/shared/hostProcess";
import * as Path from "effect/Path";
import type { AppleSessionBackend, AppleSessionTarget } from "@spiritdevs/backend/appleSession";
import { ServerConfig } from "../config.ts";
import { AppleIdSession } from "./AppleIdSession.ts";
import { XcodeInstall } from "../xcode/XcodeInstall.ts";
import { MacXcodeHost } from "../xcode/XcodeHost.ts";
import { fileXcodeJobStore } from "../xcode/XcodeJobStore.ts";
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

const decodeReleaseIntent = Schema.decodeUnknownSync(ReleaseIntent);
const decodeIntegration = Schema.decodeUnknownSync(AppleIntegration);
const decodeHealth = Schema.decodeUnknownSync(Schema.Array(AppleEnvironmentHealth));

/** Each call owns its client so concurrent requests cannot overwrite another call's bearer. */
export function makeAppleBackend(
  convexUrl: string,
  tokens: ConvexServiceTokenProvider,
): AppleBackend & { sessions: AppleSessionBackend; releases: ReleaseBackend } {
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
  async function releaseCall<A>(run: (client: ConvexHttpClient) => Promise<A>): Promise<A> {
    try {
      return await call(run);
    } catch (error) {
      const code = convexErrorCode(error);
      if (code === "publishing-disabled")
        throw releaseError("publishing-disabled", "Publishing is disabled for this app.");
      if (code === "confirmation-required")
        throw releaseError(
          "confirmation-required",
          "Confirm this exact release in the client before continuing.",
        );
      if (code === "stale-controller-lease")
        throw releaseError("stale-lease", "The release lease expired. Prepare a new attempt.");
      if (code === "release-busy")
        throw releaseError(
          "busy",
          "Another environment is allocating a build number. Retry shortly.",
        );
      if (code === "invalid-arguments")
        throw releaseError("invalid-input", "Check the release version and action fields.");
      if (code === "permission-denied" || code === "not-a-member")
        throw appleFailure("forbidden", "You no longer have permission to publish this app.");
      throw appleFailure("cloud-unavailable", "Could not verify publishing with Pathway Cloud.");
    }
  }
  const targetArgs = (input: { companyId: string; accountId: string; teamId: string }) => ({
    companyId: input.companyId,
    accountId: input.accountId,
    teamId: input.teamId,
  });
  return {
    releases: {
      prepare: async (target, caller, action) =>
        decodeReleaseIntent(
          await releaseCall((client) =>
            client.mutation(api.appleReleases.prepare, {
              ...releaseTarget(target),
              caller,
              action:
                action.kind === "testflight"
                  ? { ...action, groupIds: [...action.groupIds] }
                  : action,
            }),
          ),
        ),
      consume: async (target, caller, intentId) =>
        decodeReleaseIntent(
          await releaseCall((client) =>
            client.mutation(api.appleReleases.consume, {
              ...releaseTarget(target),
              caller,
              intentId,
            }),
          ),
        ),
      checkExecution: async (target, caller, intentId) => {
        await releaseCall((client) =>
          client.query(api.appleReleases.checkExecution, {
            ...releaseTarget(target),
            caller,
            intentId,
          }),
        );
      },
      acquireBuildLease: (target, caller, version) =>
        releaseCall((client) =>
          client.mutation(api.appleReleases.acquireBuildLease, {
            ...releaseTarget(target),
            caller,
            version,
          }),
        ),
      allocateBuildNumber: (target, caller, version, token, observedMaximum) =>
        releaseCall((client) =>
          client.mutation(api.appleReleases.allocateBuildNumber, {
            ...releaseTarget(target),
            caller,
            version,
            token,
            observedMaximum,
          }),
        ),
    },
    authorizeCaller: async (input) => {
      try {
        await call((client) => client.query(api.appleIntegrations.authorizeRuntimeCaller, input));
      } catch (error) {
        if (["permission-denied", "not-a-member"].includes(convexErrorCode(error) ?? ""))
          throw appleFailure("forbidden", "You do not have permission to use this Apple account.");
        throw error;
      }
    },
    sessions: {
      status: (target) => call((client) => client.query(api.appleSessions.status, target)),
      save: (target, input) =>
        call((client) =>
          client.action(api.appleSessions.save, {
            ...target,
            ...input,
            teams: [...input.teams],
            credential: { cookies: [...input.credential.cookies] },
          }),
        ),
      read: (target) => call((client) => client.action(api.appleSessions.read, target)),
      revoke: async (target, revision) => {
        await call((client) => client.mutation(api.appleSessions.revoke, { ...target, revision }));
      },
    },
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

/** A confirmed custody denial can release an orphaned host job. Network/auth outages cannot. */
export const makeXcodeAccountCheck =
  (backend: Pick<AppleBackend, "accountStatus">) =>
  async (target: AppleSessionTarget): Promise<boolean> => {
    try {
      await backend.accountStatus({ companyId: target.companyId, accountId: target.accountId });
      return true;
    } catch (error) {
      if (
        [
          "entity-not-found",
          "company-not-found",
          "company-unavailable",
          "permission-denied",
          "environment-not-registered",
          "environment-key-mismatch",
        ].includes(convexErrorCode(error) ?? "")
      )
        return false;
      throw error;
    }
  };

/** Initialization is shared by callers and retried after failure, only when Apple is used. */
function lazyBackend(
  initialize: () => Promise<
    AppleBackend & { sessions: AppleSessionBackend; releases: ReleaseBackend }
  >,
): AppleBackend & { sessions: AppleSessionBackend; releases: ReleaseBackend } {
  let pending: Promise<
    AppleBackend & { sessions: AppleSessionBackend; releases: ReleaseBackend }
  > | null = null;
  const get = () => {
    pending ??= initialize().catch((error: unknown) => {
      pending = null;
      throw error;
    });
    return pending;
  };
  return {
    releases: {
      prepare: async (...args) => (await get()).releases.prepare(...args),
      consume: async (...args) => (await get()).releases.consume(...args),
      checkExecution: async (...args) => (await get()).releases.checkExecution(...args),
      acquireBuildLease: async (...args) => (await get()).releases.acquireBuildLease(...args),
      allocateBuildNumber: async (...args) => (await get()).releases.allocateBuildNumber(...args),
    },
    authorizeCaller: async (input) => (await get()).authorizeCaller(input),
    sessions: {
      status: async (target) => (await get()).sessions.status(target),
      save: async (target, input) => (await get()).sessions.save(target, input),
      read: async (target) => (await get()).sessions.read(target),
      revoke: async (target, revision) => (await get()).sessions.revoke(target, revision),
    },
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
export const makeConfiguredAppleServices = Effect.fn("apple.runtime.make")(function* () {
  const config = yield* resolveCloudSyncConfig;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const unavailable = () =>
    Promise.reject(
      appleFailure(
        "cloud-unavailable",
        "Link this environment to Pathway Cloud before using Apple services.",
      ),
    );
  let backend: AppleBackend & { sessions: AppleSessionBackend; releases: ReleaseBackend } = {
    releases: {
      prepare: unavailable,
      consume: unavailable,
      checkExecution: unavailable,
      acquireBuildLease: unavailable,
      allocateBuildNumber: unavailable,
    },
    authorizeCaller: unavailable,
    sessions: { status: unavailable, save: unavailable, read: unavailable, revoke: unavailable },
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
  const sessions = new AppleIdSession(backend.sessions);
  const server = yield* ServerConfig;
  const path = yield* Path.Path;
  const root = path.join(server.stateDir, "xcode");
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const xcode = new XcodeInstall(
    new MacXcodeHost(root, sessions, { platform, arch }),
    fileXcodeJobStore(path.join(root, "job.json")),
    undefined,
    makeXcodeAccountCheck(backend),
  );
  const descriptor = yield* (yield* ServerEnvironment.ServerEnvironment).getDescriptor;
  const releaseRoot = path.join(server.stateDir, "releases");
  const releases = new ReleaseRuntime({
    host: new MacReleaseHost(releaseRoot, platform),
    store: fileReleaseStore(path.join(releaseRoot, "state.json")),
    access: new ReleaseAccess(backend),
    cloud: backend.releases,
    environment: { id: environmentId, label: descriptor.label },
  });
  yield* Effect.addFinalizer(() => Effect.promise(() => releases.dispose()));
  yield* Effect.addFinalizer(() => Effect.promise(() => xcode.dispose()));
  yield* Effect.addFinalizer(() => Effect.sync(() => sessions.dispose()));
  yield* Effect.addFinalizer(() => Effect.sync(() => runtime.dispose()));
  return { runtime, sessions, xcode, releases };
});
