// @effect-diagnostics globalDate:off globalTimers:off -- Plain runtime boundary with injectable clock; timer only disposes expired secrets, never polls.
import {
  AppleError,
  type AppleIntegration,
  type AppleEnvironmentHealth,
  type AppleStatus,
  type AppleTarget,
} from "@spiritdevs/contracts/apple";
import {
  AppStoreConnectClient,
  appleFailure,
  type AscCredential,
} from "@spiritdevs/backend/appStoreConnectApi";
import * as Schema from "effect/Schema";
import type { AppleCaller } from "../auth/appleCaller.ts";

export interface AppleBackend {
  authorizeCaller(input: {
    companyId: string;
    accountId: string;
    caller: AppleCaller;
    manage: boolean;
  }): Promise<unknown>;
  accountStatus(input: { accountId: string; companyId: string }): Promise<unknown>;
  status(
    target: AppleTarget,
  ): Promise<{ integration: AppleIntegration; environments: readonly AppleEnvironmentHealth[] }>;
  heartbeat(
    target: AppleTarget,
  ): Promise<{ integration: AppleIntegration; expiresAt: number | null }>;
  credential(
    target: AppleTarget,
    revision: number,
    accountRevision: number,
  ): Promise<AscCredential>;
  health(
    target: AppleTarget,
    accountRevision: number,
    health: Omit<AppleEnvironmentHealth, "leaseExpiresAt">,
  ): Promise<unknown>;
}
type HeldClient = {
  accountRevision: number;
  revision: number;
  expiresAt: number;
  client: AppStoreConnectClient;
  timer: ReturnType<typeof setTimeout>;
};
const isAppleError = Schema.is(AppleError);
export const safeAppleError = (error: unknown): AppleError =>
  isAppleError(error)
    ? error
    : appleFailure(
        "cloud-unavailable",
        "Could not verify the Apple connection with Pathway Cloud.",
      );

/** One per environment, shared across client sockets. Keys are never persisted. */
export class AppleRuntime {
  readonly #backend: AppleBackend;
  readonly #environmentId: string;
  readonly #makeClient: (credential: AscCredential) => AppStoreConnectClient;
  readonly #now: () => number;
  #held = new Map<string, HeldClient>();
  #queues = new Map<string, Promise<unknown>>();
  #closed = false;
  constructor(input: {
    backend: AppleBackend;
    environmentId: string;
    makeClient?: (credential: AscCredential) => AppStoreConnectClient;
    now?: () => number;
  }) {
    this.#backend = input.backend;
    this.#environmentId = input.environmentId;
    this.#makeClient = input.makeClient ?? ((credential) => new AppStoreConnectClient(credential));
    this.#now = input.now ?? Date.now;
  }
  #drop(cacheKey: string): void {
    const held = this.#held.get(cacheKey);
    if (held) {
      clearTimeout(held.timer);
      held.client.dispose();
      this.#held.delete(cacheKey);
    }
  }
  dispose(): void {
    this.#closed = true;
    for (const cacheKey of this.#held.keys()) this.#drop(cacheKey);
  }
  async #serial<A>(cacheKey: string, run: () => Promise<A>): Promise<A> {
    const previous = this.#queues.get(cacheKey);
    const current = Promise.resolve(previous)
      .catch(() => undefined)
      .then(() => {
        if (this.#closed) throw appleFailure("cloud-unavailable", "The environment is stopping.");
        return run();
      });
    this.#queues.set(cacheKey, current);
    try {
      return await current;
    } finally {
      if (this.#queues.get(cacheKey) === current) this.#queues.delete(cacheKey);
    }
  }
  #reconcile(cacheKey: string, integration: AppleIntegration): void {
    const held = this.#held.get(cacheKey);
    if (
      held &&
      (!integration.connected ||
        held.revision !== integration.revision ||
        held.accountRevision !== integration.accountRevision ||
        held.expiresAt <= this.#now())
    )
      this.#drop(cacheKey);
  }
  status(target: AppleTarget): Promise<AppleStatus> {
    const cacheKey = JSON.stringify([target.companyId, target.accountId, target.teamId]);
    return this.#serial(cacheKey, async () => {
      try {
        const result = await this.#backend.status(target);
        this.#reconcile(cacheKey, result.integration);
        return {
          integration: result.integration,
          health: result.environments.find((h) => h.environmentId === this.#environmentId) ?? {
            environmentId: this.#environmentId,
            leaseExpiresAt: null,
            connected: false,
            revision: result.integration.revision,
            lastVerifiedAt: null,
            error: null,
          },
        };
      } catch (error) {
        this.#drop(cacheKey);
        throw safeAppleError(error);
      }
    });
  }
  async #read<A>(
    target: AppleTarget,
    read: (client: AppStoreConnectClient) => Promise<A>,
  ): Promise<A> {
    const cacheKey = JSON.stringify([target.companyId, target.accountId, target.teamId]);
    return this.#serial(cacheKey, async () => {
      let accountRevision = 0;
      let revision: number | null = null;
      let lastVerifiedAt: number | null = null;
      try {
        const lease = await this.#backend.heartbeat(target);
        this.#reconcile(cacheKey, lease.integration);
        if (!lease.integration.connected || lease.expiresAt === null)
          throw appleFailure(
            "not-connected",
            "Connect an App Store Connect key in Settings → Apple.",
          );
        revision = lease.integration.revision;
        accountRevision = lease.integration.accountRevision;
        let held = this.#held.get(cacheKey);
        if (!held) {
          const credential = await this.#backend.credential(target, revision, accountRevision);
          if (this.#closed || lease.expiresAt <= this.#now())
            throw appleFailure(
              "credential-changed",
              "The Apple credential lease ended. Retry the request.",
            );
          const client = this.#makeClient(credential);
          const timer = setTimeout(() => this.#drop(cacheKey), lease.expiresAt - this.#now());
          timer.unref?.();
          held = { accountRevision, revision, expiresAt: lease.expiresAt, client, timer };
          this.#held.set(cacheKey, held);
        } else {
          clearTimeout(held.timer);
          held.expiresAt = lease.expiresAt;
          held.timer = setTimeout(() => this.#drop(cacheKey), lease.expiresAt - this.#now());
          held.timer.unref?.();
        }
        const result = await read(held.client);
        lastVerifiedAt = held.client.lastVerifiedAt;
        // A rotation during an ASC request must not publish data from the old key.
        const current = await this.#backend.status(target);
        const health = current.environments.find((h) => h.environmentId === this.#environmentId);
        if (
          !current.integration.connected ||
          current.integration.revision !== revision ||
          current.integration.accountRevision !== accountRevision ||
          !health?.connected ||
          this.#held.get(cacheKey) !== held
        )
          throw appleFailure(
            "credential-changed",
            "The Apple connection changed. Retry the request.",
          );
        await this.#backend.health(target, accountRevision, {
          environmentId: this.#environmentId,
          connected: true,
          revision,
          lastVerifiedAt,
          error: null,
        });
        return result;
      } catch (error) {
        this.#drop(cacheKey);
        const safe = safeAppleError(error);
        if (
          revision !== null &&
          safe.code !== "cloud-unavailable" &&
          safe.code !== "credential-changed"
        ) {
          await this.#backend
            .health(target, accountRevision, {
              environmentId: this.#environmentId,
              connected: true,
              revision,
              lastVerifiedAt,
              error: {
                code: safe.code,
                message: safe.message,
                retryAfterSeconds: safe.retryAfterSeconds,
              },
            })
            .catch(() => undefined);
        }
        throw safe;
      }
    });
  }
  authorizeCaller(input: Parameters<AppleBackend["authorizeCaller"]>[0]) {
    return this.#backend.authorizeCaller(input).catch((error: unknown) => {
      throw safeAppleError(error);
    });
  }
  accountStatus(input: { companyId: string; accountId: string }) {
    return this.#backend.accountStatus(input).catch((error: unknown) => {
      throw safeAppleError(error);
    });
  }
  registerBundleId(
    input: typeof import("@spiritdevs/contracts/apple").AppleRegisterBundleIdInput.Type,
  ) {
    return this.#read(input, (client) => client.registerBundleId(input));
  }
  listApps(target: AppleTarget) {
    return this.#read(target, (client) => client.listApps());
  }
  listBuilds(target: AppleTarget, appId: string) {
    return this.#read(target, (client) => client.listBuilds(appId));
  }
  listBetaGroups(target: AppleTarget, appId: string) {
    return this.#read(target, (client) => client.listBetaGroups(appId));
  }
  async testConnection(target: AppleTarget): Promise<AppleStatus> {
    try {
      await this.#read(target, (client) => {
        client.clearCache();
        return client.listApps();
      });
    } catch (error) {
      if (
        safeAppleError(error).code === "cloud-unavailable" ||
        safeAppleError(error).code === "credential-changed"
      )
        throw safeAppleError(error);
    }
    return this.status(target);
  }
}
