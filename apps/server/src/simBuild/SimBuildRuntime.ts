// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Environment-owned job coordinator with injected process, storage, and project boundaries.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  SimBuildError,
  SimBuildStartInput,
  type SimBuildContext,
  type SimBuildDiscovery,
  type SimBuildJob,
  type SimBuildJobInput,
  type SimBuildReceipt,
  type SimBuildUpdate,
} from "@spiritdevs/contracts/simBuild";
import { type DeviceSummary, LOCAL_DEVICE_HOST_ID } from "@spiritdevs/contracts";
import { SimBuildHost } from "./SimBuildHost.ts";
import { SimBuildLog } from "./SimBuildLog.ts";
import type { SimBuildStore } from "./SimBuildStore.ts";

const error = (code: SimBuildError["code"], message: string) =>
  new SimBuildError({ code, message });
const isBuildError = Schema.is(SimBuildError);
const decodeStart = Schema.decodeUnknownSync(SimBuildStartInput);
export const safeSimBuildError = (cause: unknown) =>
  isBuildError(cause)
    ? cause
    : error("process-failed", "The simulator build operation failed. See the build log.");
const sameContext = (a: SimBuildContext, b: SimBuildContext) =>
  a.environmentId === b.environmentId && a.projectId === b.projectId && a.threadId === b.threadId;
export interface SimBuildDependencies {
  /** Resolves a registered project and verifies that the thread belongs to it on this environment. */
  resolve(input: SimBuildContext, signal?: AbortSignal): Promise<string>;
  destination(input: SimBuildStartInput, signal: AbortSignal): Promise<DeviceSummary>;
  claim(input: SimBuildStartInput, signal: AbortSignal): Promise<void>;
}
interface Entry {
  job: SimBuildJob;
  receipts: SimBuildReceipt[];
  log: SimBuildLog;
  watchers: Set<() => void>;
  controller?: AbortController;
  worker?: Promise<void>;
}

/** Phase receipts are the durable source of job state. Logs are a bounded, explicitly lossy live window. */
export class SimBuildRuntime {
  readonly #entries = new Map<string, Entry>();
  #journal: Promise<void> = Promise.resolve();
  #admission: Promise<void> = Promise.resolve();
  #loaded: Promise<void> | undefined;
  #disposed = false;
  readonly root: string;
  readonly dependencies: SimBuildDependencies;
  readonly store: SimBuildStore;
  readonly host: SimBuildHost;
  readonly now: () => number;
  readonly id: () => string;
  constructor(
    root: string,
    dependencies: SimBuildDependencies,
    store: SimBuildStore,
    host: SimBuildHost,
    now = () => Date.now(),
    id: () => string = () => NodeCrypto.randomUUID(),
  ) {
    this.root = root;
    this.dependencies = dependencies;
    this.store = store;
    this.host = host;
    this.now = now;
    this.id = id;
  }
  #entry(job: SimBuildJob): Entry {
    const watchers = new Set<() => void>();
    return {
      job,
      receipts: [],
      watchers,
      log: new SimBuildLog(job.workspaceRoot, () => {
        for (const watcher of watchers) watcher();
      }),
    };
  }
  async #load() {
    this.#loaded ??= (async () => {
      for (const receipt of await this.store.load()) {
        const entry = this.#entries.get(receipt.job.id) ?? this.#entry(receipt.job);
        entry.job = receipt.job;
        entry.receipts.push(receipt);
        this.#entries.set(receipt.job.id, entry);
      }
      for (const entry of this.#entries.values())
        if (!entry.job.terminal)
          await this.#phase(entry, {
            phase: "failed",
            terminal: true,
            failure: {
              code: "interrupted",
              message: "The environment restarted before this build finished. Start a new build.",
            },
          });
    })();
    await this.#loaded;
  }
  async #phase(entry: Entry, patch: Partial<SimBuildJob>) {
    const write = this.#journal.then(async () => {
      const job = { ...entry.job, ...patch, updatedAt: this.now() };
      const receipt: SimBuildReceipt = { sequence: entry.receipts.length + 1, kind: "phase", job };
      const entries = [...this.#entries.values()];
      const recent = new Set(entries.slice(-50));
      const retained = entries.filter(
        (item) => item === entry || !item.job.terminal || recent.has(item),
      );
      try {
        await this.store.save(
          retained.flatMap((item) =>
            item === entry ? [...item.receipts, receipt] : item.receipts,
          ),
        );
      } catch {
        throw error("storage-failed", "Could not persist the simulator build phase.");
      }
      entry.job = job;
      entry.receipts.push(receipt);
      for (const item of this.#entries.values())
        if (!retained.includes(item) && item.watchers.size === 0) this.#entries.delete(item.job.id);
      entry.log.flush(job.terminal);
      for (const watcher of entry.watchers) watcher();
    });
    this.#journal = write.catch(() => undefined);
    await write;
  }
  async discover(
    input: SimBuildContext,
    signal = new AbortController().signal,
  ): Promise<SimBuildDiscovery> {
    const workspaceRoot = await this.dependencies.resolve(input, signal);
    const developerDir = await this.host.developerDir(signal);
    return {
      ...input,
      workspaceRoot,
      developerDir,
      ...(await this.host.discover(workspaceRoot, developerDir, signal)),
    };
  }
  async start(raw: SimBuildStartInput) {
    const input = decodeStart(raw);
    await this.#load();
    const admit = this.#admission.then(async () => {
      if (this.#disposed) throw error("unavailable", "The environment is stopping.");
      const workspaceRoot = await this.dependencies.resolve(input);
      for (const entry of this.#entries.values()) {
        if (sameContext(entry.job, input) && entry.job.requestId === input.requestId) {
          for (const key of Object.keys(SimBuildStartInput.fields) as (keyof SimBuildStartInput)[])
            if (entry.job[key] !== input[key])
              throw error("busy", "This requestId was already used with different build options.");
          if (entry.job.workspaceRoot !== workspaceRoot)
            throw error(
              "invalid-project",
              "The thread's checkout changed. Start with a new requestId.",
            );
          return entry.job;
        }
        if (
          !entry.job.terminal &&
          (entry.job.projectId === input.projectId ||
            (entry.job.hostId === input.hostId && entry.job.deviceId === input.deviceId))
        )
          throw error("busy", "This project or simulator already has an active build.");
      }
      if ([...this.#entries.values()].filter((entry) => !entry.job.terminal).length >= 3)
        throw error("busy", "This environment already has three active builds.");
      const controller = new AbortController();
      await this.#destination(input, controller.signal);
      const job: SimBuildJob = {
        ...input,
        id: this.id(),
        workspaceRoot,
        developerDir: null,
        phase: "resolving",
        terminal: false,
        artifact: null,
        failure: null,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      const entry = this.#entry(job);
      entry.controller = controller;
      this.#entries.set(job.id, entry);
      const accepted = this.#phase(entry, {});
      // A second client can cancel while the initial receipt is being saved.
      // Install the drain before yielding so cancel waits through acceptance too.
      entry.worker = accepted.then(
        () => this.#work(entry, controller.signal),
        () => {
          entry.job = {
            ...entry.job,
            phase: "failed",
            terminal: true,
            failure: { code: "storage-failed", message: "Could not accept the simulator build." },
          };
        },
      );
      try {
        await accepted;
      } catch (cause) {
        this.#entries.delete(job.id);
        throw cause;
      }
      return job;
    });
    this.#admission = admit.then(
      () => undefined,
      () => undefined,
    );
    return admit;
  }
  async #destination(input: SimBuildStartInput, signal: AbortSignal) {
    if (input.hostId !== LOCAL_DEVICE_HOST_ID)
      throw error(
        "invalid-destination",
        "Choose an iOS simulator on the project's environment. SSH device hosts are not build destinations.",
      );
    const device = await this.dependencies.destination(input, signal);
    if (
      device.id !== input.deviceId ||
      device.hostId !== input.hostId ||
      device.platform !== "ios" ||
      device.physical ||
      device.inUseBy
    )
      throw error(
        "invalid-destination",
        "This simulator is unavailable or belongs to another environment.",
      );
    return device;
  }
  async #work(entry: Entry, signal: AbortSignal) {
    try {
      signal.throwIfAborted();
      const input = entry.job;
      const root = input.workspaceRoot;
      const developerDir = await this.host.developerDir(signal);
      const output = (text: string, source: "stdout" | "stderr") => entry.log.write(text, source);
      const discovery = await this.host.discover(root, developerDir, signal, output);
      const selected = discovery.containers.find(
        (container) => container.path === input.containerPath,
      );
      if (
        !selected ||
        !selected.schemes.includes(input.scheme) ||
        (input.target && selected.targets.length > 0 && !selected.targets.includes(input.target))
      )
        throw error(
          "invalid-project",
          "Choose a discovered project, scheme, and application target.",
        );
      const container = await this.host.resolveContainer(root, input.containerPath);
      const configuration =
        input.configuration ?? (discovery.framework === "xcode" ? "Debug" : "Release");
      if (selected.configurations.length && !selected.configurations.includes(configuration))
        throw error("invalid-project", "Choose a configuration from the selected project.");
      const derivedData = NodePath.join(this.root, input.id, "DerivedData");
      await NodeFSP.mkdir(derivedData, { recursive: true });
      const args = this.host.args(container, input, derivedData, configuration);
      const env = { DEVELOPER_DIR: developerDir };
      const simctl = (args: string[]) =>
        this.host.run(
          { file: "/usr/bin/xcrun", args: ["simctl", ...args], cwd: root, env },
          signal,
          output,
        );
      const verify = async () => {
        signal.throwIfAborted();
        if ((await this.dependencies.resolve(input, signal)) !== root)
          throw error("invalid-project", "The thread's checkout changed during the build.");
        const device = await this.#destination(input, signal);
        await this.dependencies.claim(input, signal);
        signal.throwIfAborted();
        return device;
      };
      const device = await verify();
      if (!device.booted) await simctl(["boot", input.deviceId]);
      await simctl(["bootstatus", input.deviceId, "-b"]);
      signal.throwIfAborted();
      await this.#phase(entry, { phase: "building", developerDir });
      signal.throwIfAborted();
      await this.host.run(
        {
          file: `${developerDir}/usr/bin/xcodebuild`,
          args: [...args, input.action === "test" ? "test" : "build"],
          cwd: root,
          env,
        },
        signal,
        output,
      );
      signal.throwIfAborted();
      if (input.action === "test") {
        await this.#phase(entry, { phase: "completed", terminal: true });
        return;
      }
      const artifact = await this.host.artifact(
        root,
        developerDir,
        args,
        input,
        derivedData,
        signal,
        output,
      );
      await verify();
      if (input.action === "build") {
        await this.#phase(entry, { phase: "completed", artifact, terminal: true });
        return;
      }
      await this.#phase(entry, { phase: "installing", artifact });
      signal.throwIfAborted();
      await simctl(["install", input.deviceId, artifact.appPath]);
      await verify();
      await this.#phase(entry, { phase: "launching" });
      signal.throwIfAborted();
      await simctl(["launch", "--terminate-running-process", input.deviceId, artifact.bundleId]);
      signal.throwIfAborted();
      await this.#phase(entry, { phase: "running", terminal: true });
    } catch (cause) {
      const problem = safeSimBuildError(cause);
      const failure = signal.aborted
        ? { code: "cancelled" as const, message: "Simulator build cancelled." }
        : { code: problem.code, message: problem.message };
      try {
        await this.#phase(entry, {
          phase: signal.aborted ? "cancelled" : "failed",
          terminal: true,
          failure,
        });
      } catch {
        // Persistence loss must stop work and release waiters without inventing a durable receipt.
        entry.job = {
          ...entry.job,
          phase: "failed",
          terminal: true,
          failure: {
            code: "storage-failed",
            message:
              "Could not save the build result. Restart recovery will mark the job interrupted.",
          },
        };
        entry.log.flush(true);
        for (const watcher of entry.watchers) watcher();
      }
    } finally {
      entry.log.flush(true);
      delete entry.controller;
    }
  }
  async #get(input: SimBuildJobInput) {
    await this.dependencies.resolve(input);
    await this.#load();
    const entry = this.#entries.get(input.jobId);
    if (!entry || !sameContext(entry.job, input))
      throw error(
        "not-found",
        "No simulator build with this id belongs to this thread and environment.",
      );
    return entry;
  }
  async list(input: SimBuildContext) {
    await this.dependencies.resolve(input);
    await this.#load();
    return [...this.#entries.values()]
      .filter((entry) => sameContext(entry.job, input))
      .map((entry) => entry.job);
  }
  async get(input: SimBuildJobInput, afterReceipt = 0, afterLog = 0): Promise<SimBuildUpdate> {
    const entry = await this.#get(input);
    return {
      kind: afterReceipt === 0 ? "snapshot" : "update",
      job: entry.job,
      receipts: entry.receipts.filter((receipt) => receipt.sequence > afterReceipt),
      logs: entry.log.chunks.filter((chunk) => chunk.sequence > afterLog),
      firstLogSequence: entry.log.chunks[0]?.sequence ?? entry.log.nextSequence,
      nextLogSequence: entry.log.nextSequence,
    };
  }
  async watch(input: SimBuildJobInput, notify: () => void) {
    const entry = await this.#get(input);
    entry.watchers.add(notify);
    notify();
    return () => {
      entry.watchers.delete(notify);
    };
  }
  /** Completion receipt plus worker drain, used by cancellation and agent wait. */
  async drain(input: SimBuildJobInput) {
    const entry = await this.#get(input);
    await entry.worker;
    return entry.job;
  }
  async cancel(input: SimBuildJobInput) {
    const entry = await this.#get(input);
    if (!entry.job.terminal) entry.controller?.abort();
    await entry.worker;
    return entry.job;
  }
  async dispose() {
    this.#disposed = true;
    await this.#admission;
    for (const entry of this.#entries.values()) entry.controller?.abort();
    await Promise.all([...this.#entries.values()].map((entry) => entry.worker));
  }
}
