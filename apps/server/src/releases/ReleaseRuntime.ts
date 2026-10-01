// @effect-diagnostics globalDate:off globalTimers:off cryptoRandomUUID:off nodeBuiltinImport:off -- Promise worker with injected clock/host; timers only coalesce byte progress.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { AppleError } from "@spiritdevs/contracts/apple";
import {
  ReleaseError,
  type ReleaseTarget,
  type ReleaseArchiveInput,
  type ReleaseAction,
  type ReleaseIntent,
  type ReleaseJob,
  type LocalReleaseArchive,
  type ReleaseOrganizer,
} from "@spiritdevs/contracts/releases";
import type { AppleCaller } from "../auth/appleCaller.ts";
import { type ReleaseHost, releaseError } from "./ReleaseHost.ts";
import type { ReleaseStore, ReleaseState } from "./ReleaseStore.ts";
import type { ReleaseAccess } from "./ReleaseAccess.ts";
export interface ReleaseBackend {
  prepare(
    target: ReleaseTarget,
    caller: AppleCaller,
    action: ReleaseAction,
  ): Promise<ReleaseIntent>;
  consume(target: ReleaseTarget, caller: AppleCaller, intentId: string): Promise<ReleaseIntent>;
  checkExecution(target: ReleaseTarget, caller: AppleCaller, intentId: string): Promise<void>;
  acquireBuildLease(
    target: ReleaseTarget,
    caller: AppleCaller,
    version: string,
  ): Promise<{ token: string; expiresAt: number }>;
  allocateBuildNumber(
    target: ReleaseTarget,
    caller: AppleCaller,
    version: string,
    token: string,
    observedMaximum: number,
  ): Promise<string>;
}
export const sameReleaseTarget = (a: ReleaseTarget, b: ReleaseTarget) =>
  a.companyId === b.companyId &&
  a.accountId === b.accountId &&
  a.teamId === b.teamId &&
  a.appId === b.appId;
export const releaseTarget = (input: ReleaseTarget): ReleaseTarget => ({
  companyId: input.companyId,
  accountId: input.accountId,
  teamId: input.teamId,
  appId: input.appId,
});
const key = (target: ReleaseTarget) => JSON.stringify(releaseTarget(target));
const isReleaseError = Schema.is(ReleaseError);
const isAppleError = Schema.is(AppleError);
export function safeReleaseError(error: unknown): ReleaseError | AppleError {
  if (isReleaseError(error) || isAppleError(error)) return error;
  return releaseError(
    "operation-failed",
    "The release operation failed. Check its current state before retrying.",
  );
}
/** One worker per environment. Jobs outlive sockets; no job auto-replays after a restart. */
export class ReleaseRuntime {
  readonly #host: ReleaseHost;
  readonly #store: ReleaseStore;
  readonly #access: ReleaseAccess;
  readonly #cloud: ReleaseBackend;
  readonly #environment: { id: string; label: string };
  readonly #now: () => number;
  #state: ReleaseState = { archives: [], jobs: [] };
  #ready: Promise<void> | undefined;
  #serial: Promise<unknown> = Promise.resolve();
  #worker: { id: string; controller: AbortController; done: Promise<void> } | null = null;
  #closed = false;
  #views = new Map<string, Set<(kind: "organizer" | "local") => void>>();
  #cache = new Map<string, { until: number; value: ReleaseOrganizer }>();
  constructor(input: {
    host: ReleaseHost;
    store: ReleaseStore;
    access: ReleaseAccess;
    cloud: ReleaseBackend;
    environment: { id: string; label: string };
    now?: () => number;
  }) {
    this.#host = input.host;
    this.#store = input.store;
    this.#access = input.access;
    this.#cloud = input.cloud;
    this.#environment = input.environment;
    this.#now = input.now ?? Date.now;
  }
  async #initialize() {
    this.#ready ??= (async () => {
      this.#state = await this.#store.load();
      await this.#host.recover();
      this.#state = {
        ...this.#state,
        jobs: this.#state.jobs.map((job) =>
          job.state === "running"
            ? {
                ...job,
                state: "interrupted",
                error: {
                  code: "interrupted",
                  message:
                    "The environment restarted. Reconcile Apple status before preparing another attempt.",
                },
                updatedAt: this.#now(),
              }
            : job,
        ),
      };
      await this.#store.save(this.#state);
    })();
    await this.#ready;
  }
  async #lock<A>(run: () => Promise<A>): Promise<A> {
    const current = this.#serial
      .catch(() => undefined)
      .then(async () => {
        await this.#initialize();
        return run();
      });
    this.#serial = current;
    return current;
  }
  #notify(target: ReleaseTarget, kind: "organizer" | "local") {
    for (const listener of this.#views.get(key(target)) ?? []) listener(kind);
  }
  watch(target: ReleaseTarget, listener: (kind: "organizer" | "local") => void) {
    const k = key(target);
    const listeners = this.#views.get(k) ?? new Set();
    listeners.add(listener);
    this.#views.set(k, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        this.#views.delete(k);
        this.#cache.delete(k);
      }
    };
  }
  async localStatus(target: ReleaseTarget) {
    await this.#initialize();
    return {
      environmentId: this.#environment.id,
      environmentLabel: this.#environment.label,
      archives: this.#state.archives.filter((a) => sameReleaseTarget(a.target, target)),
      jobs: this.#state.jobs.filter((j) => sameReleaseTarget(j.target, target)),
    };
  }
  refresh(target: ReleaseTarget) {
    this.#cache.delete(key(target));
    this.#notify(target, "organizer");
  }
  async organizer(
    target: ReleaseTarget,
    caller: AppleCaller,
    signal: AbortSignal,
  ): Promise<ReleaseOrganizer> {
    if (!this.#views.get(key(target))?.size)
      throw releaseError(
        "invalid-input",
        "Subscribe to the Releases view before reading App Store Connect.",
      );
    const cached = this.#cache.get(key(target));
    const result = await this.#access.run(
      target,
      caller,
      false,
      signal,
      async () => {},
      async (client) =>
        cached && cached.until > this.#now() ? cached.value : client.organizer(target.appId),
    );
    if (this.#views.get(key(target))?.size)
      this.#cache.set(key(target), {
        until: cached?.value === result ? cached.until : this.#now() + 30_000,
        value: result,
      });
    return result;
  }
  async prepare(target: ReleaseTarget, caller: AppleCaller, action: ReleaseAction) {
    await this.#initialize();
    if (action.kind === "upload") {
      const archive = this.#archive(target, action.archiveId);
      if (
        archive.artifactSha256 !== action.artifactSha256 ||
        archive.version !== action.version ||
        archive.buildNumber !== action.buildNumber ||
        archive.platform !== action.platform
      )
        throw releaseError(
          "artifact-changed",
          "Prepare the upload from the current archive metadata.",
        );
      await this.#host.source(archive);
    }
    return this.#cloud.prepare(target, caller, action);
  }
  #archive(target: ReleaseTarget, id: string) {
    const archive = this.#state.archives.find(
      (a) => a.id === id && sameReleaseTarget(a.target, target),
    );
    if (!archive)
      throw releaseError("not-found", "The archive is unavailable in this environment and app.");
    return archive;
  }
  async #saveJob(job: ReleaseJob) {
    this.#state = {
      ...this.#state,
      jobs: this.#state.jobs.map((j) => (j.id === job.id ? job : j)),
    };
    await this.#store.save(this.#state);
    this.#notify(job.target, "local");
  }
  async #start(
    target: ReleaseTarget,
    kind: ReleaseJob["kind"],
    intentId: string | null,
    run: (
      job: ReleaseJob,
      signal: AbortSignal,
      patch: (values: Partial<ReleaseJob>) => Promise<void>,
    ) => Promise<void>,
  ) {
    if (this.#closed) throw releaseError("interrupted", "The environment is stopping.");
    if (this.#worker)
      throw releaseError("busy", "Another release job is running on this environment.");
    let job: ReleaseJob = {
      id: NodeCrypto.randomUUID(),
      target: releaseTarget(target),
      kind,
      state: "running",
      phase: "preparing",
      progress: null,
      archiveId: null,
      intentId,
      resourceId: null,
      error: null,
      createdAt: this.#now(),
      updatedAt: this.#now(),
    };
    this.#state = { ...this.#state, jobs: [...this.#state.jobs, job] };
    await this.#store.save(this.#state);
    const accepted = job;
    const controller = new AbortController();
    const patch = async (values: Partial<ReleaseJob>) => {
      job = { ...job, ...values, updatedAt: this.#now() };
      await this.#saveJob(job);
    };
    const done = Promise.resolve()
      .then(async () => {
        try {
          await run(job, controller.signal, patch);
          controller.signal.throwIfAborted();
          await patch({
            state: "completed",
            phase: kind === "upload" ? "uploaded-awaiting-processing" : "completed",
          });
        } catch (error) {
          const safe = safeReleaseError(error);
          await patch({
            state: controller.signal.aborted ? "cancelled" : "failed",
            error: {
              code: controller.signal.aborted
                ? "cancelled"
                : isReleaseError(safe)
                  ? safe.code
                  : "operation-failed",
              message: controller.signal.aborted
                ? "The release job was stopped. Apple may already have received part of it; reconcile before retrying."
                : safe.message,
            },
          });
        }
      })
      .finally(() => {
        this.#worker = null;
        this.refresh(target);
        this.#notify(target, "local");
      });
    this.#worker = { id: job.id, controller, done };
    // Persist errors are surfaced by status/drain without an unhandled worker rejection.
    void done.catch(() => undefined);
    this.#notify(target, "local");
    return accepted;
  }
  archive(input: ReleaseArchiveInput, caller: AppleCaller) {
    return this.#lock(() =>
      this.#start(input, "archive", null, async (job, signal, patch) => {
        await this.#access.run(
          input,
          caller,
          true,
          signal,
          async () => {},
          async (client, credential, leaseSignal) => {
            const app = (await client.listApps()).find((a) => a.id === input.appId);
            if (!app)
              throw releaseError("invalid-input", "Choose an app accessible to this Apple key.");
            const lease = await this.#cloud.acquireBuildLease(input, caller, input.version);
            const maximum = await client.highestBuildNumber(input.appId, input.version);
            const buildNumber = await this.#cloud.allocateBuildNumber(
              input,
              caller,
              input.version,
              lease.token,
              maximum,
            );
            const result = await this.#host.archive(
              input,
              job.id,
              buildNumber,
              app.bundleId,
              credential,
              leaseSignal,
              (phase) => patch({ phase }),
            );
            const archive: LocalReleaseArchive = {
              id: job.id,
              target: releaseTarget(input),
              environmentId: this.#environment.id,
              environmentLabel: this.#environment.label,
              projectPath: input.projectPath,
              scheme: input.scheme,
              bundleId: app.bundleId,
              version: input.version,
              buildNumber,
              platform: input.platform,
              createdAt: this.#now(),
              ...result,
            };
            this.#state = { ...this.#state, archives: [...this.#state.archives, archive] };
            await patch({ archiveId: archive.id });
          },
        );
      }),
    );
  }
  execute(target: ReleaseTarget, caller: AppleCaller, intentId: string) {
    return this.#lock(async () => {
      if (this.#worker)
        throw releaseError("busy", "Another release job is running on this environment.");
      if (this.#closed) throw releaseError("interrupted", "The environment is stopping.");
      const intent = await this.#cloud.consume(target, caller, intentId);
      return this.#start(target, intent.action.kind, intentId, async (_job, signal, patch) => {
        const check = () => this.#cloud.checkExecution(target, caller, intentId);
        await this.#access.run(target, caller, true, signal, check, async (client) => {
          await check();
          if (intent.action.kind === "upload") {
            const archive = this.#archive(target, intent.action.archiveId);
            if (
              archive.artifactSha256 !== intent.action.artifactSha256 ||
              archive.version !== intent.action.version ||
              archive.buildNumber !== intent.action.buildNumber ||
              archive.platform !== intent.action.platform
            )
              throw releaseError("artifact-changed", "The confirmed archive changed.");
            const source = await this.#host.source(archive);
            await patch({ phase: "uploading", archiveId: archive.id });
            let last = 0;
            const progress = (bytes: number, total: number) => {
              if (this.#now() - last < 350 && bytes !== total) return;
              last = this.#now();
              // Byte ticks update the in-memory snapshot only; milestone patches persist it.
              this.#state = {
                ...this.#state,
                jobs: this.#state.jobs.map((j) =>
                  j.id === _job.id ? { ...j, progress: { bytes, total } } : j,
                ),
              };
              this.#notify(target, "local");
            };
            const resourceId = await client.upload(
              target.appId,
              intent.action,
              source,
              progress,
              (id) => patch({ resourceId: id }),
            );
            await patch({ resourceId, progress: { bytes: source.size, total: source.size } });
          } else {
            await patch({ phase: "submitting" });
            const resourceId = await client.publish(target.appId, intent.action);
            await patch({ resourceId });
          }
        });
      });
    });
  }
  cancel(target: ReleaseTarget, jobId: string) {
    return this.#lock(async () => {
      const job = this.#state.jobs.find(
        (j) => j.id === jobId && sameReleaseTarget(j.target, target),
      );
      if (!job) throw releaseError("not-found", "The release job is unavailable.");
      if (this.#worker?.id === jobId) {
        const worker = this.#worker;
        worker.controller.abort();
        await worker.done;
      }
      return this.#state.jobs.find((j) => j.id === jobId)!;
    });
  }
  async drain() {
    await this.#serial.catch(() => undefined);
    await this.#worker?.done;
  }
  async dispose() {
    this.#closed = true;
    await this.#serial.catch(() => undefined);
    this.#worker?.controller.abort();
    await this.#worker?.done;
    this.#views.clear();
    this.#cache.clear();
  }
}
