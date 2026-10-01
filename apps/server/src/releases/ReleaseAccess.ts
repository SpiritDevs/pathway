// @effect-diagnostics globalDate:off globalTimers:off -- Timers renew only active work and abort at credential lease expiry.
import type { ReleaseTarget } from "@spiritdevs/contracts/releases";
import type { AppleBackend } from "../apple/AppleRuntime.ts";
import { appleFailure, type AscCredential } from "@spiritdevs/backend/appStoreConnectApi";
import { AppStoreReleaseClient } from "@spiritdevs/backend/appStoreReleaseApi";
import type { AppleCaller } from "../auth/appleCaller.ts";
export class ReleaseAccess {
  readonly #backend: AppleBackend;
  readonly #makeClient: (
    credential: AscCredential,
    signal: AbortSignal,
    beforeWrite: () => Promise<void>,
  ) => AppStoreReleaseClient;
  constructor(
    backend: AppleBackend,
    makeClient = (
      credential: AscCredential,
      signal: AbortSignal,
      beforeWrite: () => Promise<void>,
    ) => new AppStoreReleaseClient(credential, undefined, undefined, signal, beforeWrite),
  ) {
    this.#backend = backend;
    this.#makeClient = makeClient;
  }
  async run<A>(
    target: ReleaseTarget,
    caller: AppleCaller,
    manage: boolean,
    signal: AbortSignal,
    beforeWrite: () => Promise<void>,
    run: (
      client: AppStoreReleaseClient,
      credential: AscCredential,
      signal: AbortSignal,
    ) => Promise<A>,
  ): Promise<A> {
    const backend = this.#backend;
    const authorize = () =>
      backend.authorizeCaller({
        companyId: target.companyId,
        accountId: target.accountId,
        caller,
        manage,
      });
    await authorize();
    const lease = await backend.heartbeat(target);
    if (!lease.integration.connected || !lease.expiresAt)
      throw appleFailure("not-connected", "Connect an App Store Connect key first.");
    const credential = await backend.credential(
      target,
      lease.integration.revision,
      lease.integration.accountRevision,
    );
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    let failure: unknown;
    let renewal: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const client = this.#makeClient(credential, combined, async () => {
      await authorize();
      await beforeWrite();
      combined.throwIfAborted();
    });
    const abort = () => client.dispose();
    combined.addEventListener("abort", abort, { once: true });
    const expire = () => {
      failure = appleFailure(
        "credential-changed",
        "The Apple credential lease ended. Check the release before trying again.",
      );
      controller.abort();
    };
    const arm = (expiresAt: number) => {
      if (deadline) clearTimeout(deadline);
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        expire();
        return;
      }
      deadline = setTimeout(expire, remaining);
      deadline.unref?.();
      renewal = setTimeout(
        () => {
          void (async () => {
            try {
              await authorize();
              if (stopped || combined.aborted) return;
              const next = await backend.heartbeat(target);
              if (stopped || combined.aborted) return;
              if (
                !next.integration.connected ||
                next.integration.revision !== lease.integration.revision ||
                next.integration.accountRevision !== lease.integration.accountRevision ||
                !next.expiresAt
              ) {
                expire();
                return;
              }
              if (manage) await beforeWrite();
              if (!stopped && !combined.aborted) arm(next.expiresAt);
            } catch (error) {
              failure = error;
              controller.abort();
            }
          })();
        },
        Math.max(1, Math.min(20_000, remaining - 5_000)),
      );
      renewal.unref?.();
    };
    try {
      arm(lease.expiresAt);
      combined.throwIfAborted();
      const result = await run(client, credential, combined);
      await authorize();
      const current = await backend.heartbeat(target);
      if (
        current.integration.revision !== lease.integration.revision ||
        current.integration.accountRevision !== lease.integration.accountRevision ||
        !current.integration.connected
      )
        expire();
      if (failure) throw failure;
      combined.throwIfAborted();
      return result;
    } catch (error) {
      throw failure ?? error;
    } finally {
      stopped = true;
      if (renewal) clearTimeout(renewal);
      if (deadline) clearTimeout(deadline);
      combined.removeEventListener("abort", abort);
      client.dispose();
    }
  }
}
