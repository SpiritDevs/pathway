// @effect-diagnostics globalDate:off globalTimers:off -- Durable host job boundary, with injected clock and driver.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import {
  XcodeError,
  XcodeJob,
  type XcodeStatus,
  type XcodeStepId,
  type XcodeStep,
  type XcodePlatform,
} from "@spiritdevs/contracts/xcode";
import type { AppleSessionTarget } from "@spiritdevs/backend/appleSession";

export const sameXcodeAccount = (a: AppleSessionTarget, b: AppleSessionTarget) =>
  a.companyId === b.companyId && a.accountId === b.accountId;

export const xcodeError = (code: XcodeError["code"], message: string) =>
  new XcodeError({ code, message });
export interface XcodeJobStore {
  load(): Promise<XcodeJob | null>;
  save(job: XcodeJob): Promise<void>;
}
export interface XcodeHost {
  readonly supported: boolean;
  inspect(): Promise<Omit<XcodeStatus, "job">>;
  installPath(versionId: string): Promise<string>;
  interrupt?(job: XcodeJob): Promise<void>;
  cleanup?(job: XcodeJob): Promise<void>;
  needsAdmin(step: XcodeStepId): boolean;
  run(
    step: XcodeStepId,
    job: XcodeJob,
    signal: AbortSignal,
    progress: (value: NonNullable<XcodeStep["progress"]>) => void,
  ): Promise<void>;
}
const allSteps: readonly XcodeStepId[] = [
  "check",
  "download",
  "expand",
  "move",
  "license",
  "select",
  "first-launch",
  "runtimes",
  "helpers",
];
const active = (job: XcodeJob | null) =>
  job &&
  ["running", "needs-admin", "needs-reauth", "interrupted", "cancelling"].includes(job.state);
const isXcodeError = Schema.is(XcodeError);
const safe = (error: unknown) =>
  isXcodeError(error)
    ? error
    : xcodeError("process-failed", "The Xcode operation failed. Retry this step.");

/** One worker per environment. RPC disconnects do not own or interrupt its lifetime. */
export class XcodeInstall {
  #job: XcodeJob | null = null;
  #initialized: Promise<void> | null = null;
  #operations: Promise<unknown> = Promise.resolve();
  #worker: Promise<void> | null = null;
  #controller: AbortController | null = null;
  #watchers = new Set<(status: XcodeStatus) => void>();
  #snapshot: Omit<XcodeStatus, "job">;
  #notification: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  readonly host: XcodeHost;
  readonly store: XcodeJobStore;
  readonly now: () => number;
  readonly accountAvailable: (account: AppleSessionTarget) => Promise<boolean>;
  constructor(
    host: XcodeHost,
    store: XcodeJobStore,
    now = Date.now,
    accountAvailable: (account: AppleSessionTarget) => Promise<boolean> = async () => true,
  ) {
    this.host = host;
    this.store = store;
    this.now = now;
    this.accountAvailable = accountAvailable;
    this.#snapshot = {
      host: host.supported ? "mac" : "needs-mac",
      installed: [],
      available: [],
      runtimes: [],
      disk: { freeBytes: null, requiredBytes: 45 * 1024 ** 3 },
      error: null,
    };
  }
  async #init() {
    this.#initialized ??= (async () => {
      this.#job = await this.store.load();
      if (this.#job && ["running", "needs-admin", "cancelling"].includes(this.#job.state)) {
        await this.host.interrupt?.(this.#job);
        this.#job = {
          ...this.#job,
          state: "interrupted",
          updatedAt: this.now(),
          steps: this.#job.steps.map((s) =>
            s.state === "running" || s.state === "needs-admin"
              ? {
                  ...s,
                  state: "failed",
                  error: {
                    code: "interrupted",
                    message: "The environment restarted. Retry to resume this step.",
                  },
                }
              : s,
          ),
        };
        await this.store.save(this.#job);
      }
    })();
    await this.#initialized;
  }
  async #serial<A>(run: () => Promise<A>): Promise<A> {
    const pending = this.#operations
      .catch(() => undefined)
      .then(async () => {
        await this.#init();
        if (this.#closed) throw xcodeError("interrupted", "The environment is stopping.");
        return run();
      });
    this.#operations = pending;
    return pending;
  }
  #notify() {
    if (this.#notification || this.#closed) return;
    this.#notification = setTimeout(() => {
      this.#notification = null;
      const snapshot = { ...this.#snapshot, job: this.#job };
      for (const listener of this.#watchers) listener(snapshot);
    }, 350);
    this.#notification.unref?.();
  }
  async #save(job: XcodeJob) {
    const next = { ...job, updatedAt: this.now() };
    try {
      await this.store.save(next);
    } catch {
      throw xcodeError(
        "storage-failed",
        "Could not save the Xcode job. Check the host disk before retrying.",
      );
    }
    this.#job = next;
    this.#notify();
  }
  /** Only an environment-level denial proves orphaning; a different caller's denial does not. */
  async #reconcileAccount() {
    const orphan = await this.#serial(async () => {
      const job = this.#job;
      if (!job || !active(job) || (await this.accountAvailable(job.account))) return null;
      const failure = xcodeError(
        "cancelled",
        "The Apple account was removed or this environment no longer has access. Start a new Xcode job with an available account.",
      );
      const worker = this.#worker;
      await this.#save({
        ...job,
        state: worker ? "cancelling" : "cancelled",
        steps: this.#cancelledSteps(job, failure),
      });
      this.#controller?.abort(failure);
      return { id: job.id, worker, failure };
    });
    if (!orphan?.worker) return;
    // The worker persists its own exit; never join it while holding the command queue.
    await orphan.worker;
    await this.#serial(async () => {
      const job = this.#job;
      if (job?.id === orphan.id && job.state !== "cancelled")
        await this.#save({
          ...job,
          state: "cancelled",
          steps: this.#cancelledSteps(job, orphan.failure),
        });
    });
  }
  #cancelledSteps(job: XcodeJob, error: XcodeError): readonly XcodeStep[] {
    return job.steps.map((step) =>
      ["completed", "skipped"].includes(step.state)
        ? step
        : { ...step, state: "cancelled", error: { code: error.code, message: error.message } },
    );
  }
  async status(): Promise<XcodeStatus> {
    await this.#reconcileAccount();
    try {
      this.#snapshot = await this.host.inspect();
    } catch (error) {
      this.#snapshot = { ...this.#snapshot, error: safe(error) };
    }
    const requiredBytes = this.#job
      ? ((this.#job.kind === "install" ? 45 : this.#job.kind === "runtimes" ? 5 : 0) +
          this.#job.platforms.length * 15) *
        1024 ** 3
      : this.#snapshot.disk.requiredBytes;
    this.#snapshot = { ...this.#snapshot, disk: { ...this.#snapshot.disk, requiredBytes } };
    return { ...this.#snapshot, job: this.#job };
  }
  watch(listener: (status: XcodeStatus) => void) {
    this.#watchers.add(listener);
    return () => {
      this.#watchers.delete(listener);
    };
  }
  async #start(
    kind: XcodeJob["kind"],
    path: string,
    versionId: string | null,
    account: AppleSessionTarget,
    platforms: readonly XcodePlatform[],
  ) {
    if (!this.host.supported) throw xcodeError("needs-mac", "Xcode needs a Mac host.");
    if (this.#worker || active(this.#job))
      throw xcodeError("busy", "Finish or cancel the current Xcode job first.");
    if (this.#job) await this.host.cleanup?.(this.#job);
    const ids =
      kind === "install"
        ? allSteps
        : kind === "select"
          ? ["check", "select"]
          : ["check", "runtimes"];
    await this.#save({
      id: NodeCrypto.randomUUID(),
      kind,
      path,
      versionId,
      account: {
        companyId: account.companyId,
        accountId: account.accountId,
      } as XcodeJob["account"],
      platforms: [...new Set(platforms)],
      state: "running",
      createdAt: this.now(),
      updatedAt: this.now(),
      steps: allSteps.map((id) => ({
        id,
        state:
          ids.includes(id) && (id !== "runtimes" || platforms.length > 0) ? "pending" : "skipped",
        error: null,
        progress: null,
      })),
    });
    this.#launch(false);
    return this.#job!;
  }
  async install(
    account: AppleSessionTarget,
    versionId: string,
    platforms: readonly XcodePlatform[],
  ) {
    await this.#reconcileAccount();
    return this.#serial(async () => {
      if (!this.host.supported) throw xcodeError("needs-mac", "Xcode needs a Mac host.");
      return this.#start(
        "install",
        await this.host.installPath(versionId),
        versionId,
        { companyId: account.companyId, accountId: account.accountId },
        platforms,
      );
    });
  }
  async select(account: AppleSessionTarget, path: string) {
    await this.#reconcileAccount();
    return this.#serial(() => this.#start("select", path, null, account, []));
  }
  async installRuntimes(
    account: AppleSessionTarget,
    path: string,
    platforms: readonly XcodePlatform[],
  ) {
    await this.#reconcileAccount();
    return this.#serial(() => this.#start("runtimes", path, null, account, platforms));
  }
  #require(account: AppleSessionTarget, jobId: string) {
    if (!this.#job || this.#job.id !== jobId || !sameXcodeAccount(this.#job.account, account))
      throw xcodeError("not-found", "This Xcode job is no longer current.");
    return this.#job;
  }
  retry(account: AppleSessionTarget, jobId: string) {
    return this.#serial(async () => {
      const job = this.#require(account, jobId);
      if (
        this.#worker ||
        !["failed", "cancelled", "interrupted", "needs-reauth"].includes(job.state)
      )
        throw xcodeError("busy", "This Xcode job cannot be retried yet.");
      await this.#save({
        ...job,
        state: "running",
        steps: job.steps.map((s) =>
          s.state === "failed" || s.state === "cancelled" || s.state === "needs-admin"
            ? { ...s, state: "pending", error: null }
            : s,
        ),
      });
      this.#launch(false);
      return this.#job!;
    });
  }
  approve(account: AppleSessionTarget, jobId: string) {
    return this.#serial(async () => {
      const job = this.#require(account, jobId);
      if (this.#worker || job.state !== "needs-admin")
        throw xcodeError("busy", "This Xcode job is not waiting for admin approval.");
      this.#launch(true);
      return job;
    });
  }
  async cancel(account: AppleSessionTarget, jobId: string) {
    await this.#serial(async () => {
      const job = this.#require(account, jobId);
      if (job.state === "completed" || job.state === "cancelled") return;
      if (this.#worker) {
        await this.#save({ ...job, state: "cancelling" });
        this.#controller?.abort();
      } else
        await this.#save({
          ...job,
          state: "cancelled",
          steps: job.steps.map((s) =>
            s.state === "pending" || s.state === "needs-admin" ? { ...s, state: "cancelled" } : s,
          ),
        });
    });
    // Return immediately; the worker publishes cancelled only after its child has exited.
    return this.#require(account, jobId);
  }
  #launch(approved: boolean) {
    const controller = new AbortController();
    this.#controller = controller;
    this.#worker = this.#run(controller, approved)
      .catch((error) => {
        // Persistence failure must stop the worker, never continue unrecorded host mutations.
        this.#snapshot = { ...this.#snapshot, error: safe(error) };
        if (this.#job) this.#job = { ...this.#job, state: "failed" };
        this.#notify();
      })
      .finally(() => {
        this.#worker = null;
        this.#controller = null;
      });
  }
  async #run(controller: AbortController, approved: boolean) {
    for (const id of allSteps) {
      let job = this.#job!;
      const step = job.steps.find((s) => s.id === id)!;
      if (["completed", "skipped"].includes(step.state)) continue;
      const update = (state: XcodeStep["state"], error: XcodeStep["error"] = null) =>
        this.#job!.steps.map((s) => (s.id === id ? { ...s, state, error } : s));
      try {
        controller.signal.throwIfAborted();
        if (this.host.needsAdmin(id) && !approved) {
          await this.#serial(() =>
            this.#save({ ...this.#job!, state: "needs-admin", steps: update("needs-admin") }),
          );
          return;
        }
        approved = false;
        await this.#serial(() =>
          this.#save({
            ...this.#job!,
            state: this.host.needsAdmin(id) ? "needs-admin" : "running",
            steps: update(this.host.needsAdmin(id) ? "needs-admin" : "running"),
          }),
        );
        job = this.#job!;
        await this.host.run(id, job, controller.signal, (progress) => {
          if (controller.signal.aborted || this.#closed || !this.#job) return;
          this.#job = {
            ...this.#job,
            steps: this.#job.steps.map((s) => (s.id === id ? { ...s, progress } : s)),
          };
          this.#notify();
        });
        controller.signal.throwIfAborted();
        await this.#serial(() => this.#save({ ...this.#job!, steps: update("completed") }));
      } catch (error) {
        if (this.#closed) return;
        const cancelled = controller.signal.aborted;
        const failure = cancelled
          ? isXcodeError(controller.signal.reason)
            ? controller.signal.reason
            : xcodeError("cancelled", "The Xcode job was cancelled.")
          : safe(error);
        await this.#serial(() =>
          this.#save({
            ...this.#job!,
            state: cancelled
              ? "cancelled"
              : failure.code === "reauth-required"
                ? "needs-reauth"
                : "failed",
            steps: update(cancelled ? "cancelled" : "failed", {
              code: failure.code,
              message: failure.message,
            }),
          }),
        );
        return;
      }
    }
    await this.#serial(() => this.#save({ ...this.#job!, state: "completed" }));
    await this.host.cleanup?.(this.#job!);
    await this.status();
    this.#notify();
  }
  /** A receipt for tests and shutdown; no polling or sleeps. */
  async drained() {
    await this.#operations.catch(() => undefined);
    await this.#worker;
  }
  async dispose() {
    this.#closed = true;
    this.#controller?.abort();
    if (this.#notification) clearTimeout(this.#notification);
    this.#watchers.clear();
    await this.#worker;
  }
}
