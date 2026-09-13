// @effect-diagnostics nodeBuiltinImport:off -- This desktop boundary owns native inference child processes and their private pipes.
// @effect-diagnostics globalTimers:off -- Child-process startup and inference deadlines run outside an Effect fiber.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import type { DictationModelId } from "@spiritdevs/contracts/dictation";
import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import { DICTATION_VAD_ARTIFACT, dictationModelPath } from "./DictationModels.ts";

export interface DictationInferenceOptions {
  engineDirectory: string;
  modelDirectory: string;
  platform?: NodeJS.Platform;
  device?: "auto" | "cpu" | "gpu";
  threads?: number;
  onChange?: () => void;
  onLoadedChange?: (id: DictationModelId, loaded: boolean) => void;
  /** Allows fixture child processes without loading model weights. */
  spawn?: (executable: string, args: string[]) => NodeChildProcess.ChildProcessWithoutNullStreams;
  loadTimeoutMs?: number;
  inferenceTimeoutMs?: number;
}

export interface DictationTranscriptionRequest {
  audioPath: string;
  modelId: DictationModelId;
  language: string;
  terms: readonly string[];
  signal?: AbortSignal;
}

export interface DictationCleanupRequest {
  text: string;
  terms: readonly string[];
  /** Pass the selected speech language, or auto to infer it from the text. */
  language?: string;
  signal?: AbortSignal;
}

const maxLineBytes = 64 * 1024;
const maxTextBytes = 24 * 1024;
const abortError = () => new DOMException("Dictation was cancelled.", "AbortError");
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
};

/** One request per pipe. Cancelling destroys its process, so its output cannot reach a later turn. */
class EngineProcess {
  private readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  private readonly ready = deferred<void>();
  private readonly closed = deferred<void>();
  private pending: { id: string; result: ReturnType<typeof deferred<string>> } | undefined;
  private buffer = Buffer.alloc(0);
  private loadTimer: ReturnType<typeof setTimeout>;
  private stopped = false;
  private loaded = false;
  private readonly changed: (loaded: boolean) => void;

  constructor(
    child: NodeChildProcess.ChildProcessWithoutNullStreams,
    timeoutMs: number,
    changed: (loaded: boolean) => void,
  ) {
    this.child = child;
    this.changed = changed;
    this.loadTimer = setTimeout(() => {
      void this.stop(new Error("The dictation model took too long to load."));
    }, timeoutMs);
    this.loadTimer.unref();
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    // Drain diagnostics without retaining transcript-bearing upstream messages.
    child.stderr.resume();
    child.stdin.on("error", () => {
      void this.stop(new Error("The dictation engine input pipe closed."));
    });
    child.on("error", () => {
      void this.stop(
        new Error("The dictation engine could not start. Check the desktop installation."),
      );
    });
    child.once("close", () => {
      this.closed.resolve();
      void this.stop(new Error("The dictation engine exited before completing its request."));
    });
  }

  get isLoaded() {
    return this.loaded && !this.stopped;
  }

  async request(
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<string> {
    const onAbort = () => {
      void this.stop(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (signal?.aborted) onAbort();
      await this.ready.promise;
      signal?.throwIfAborted();
      if (this.stopped) throw new Error("The dictation engine has stopped.");
      if (this.pending) throw new Error("The dictation engine is busy.");
      const id = NodeCrypto.randomUUID();
      const line = JSON.stringify({ ...payload, id }) + "\n";
      if (Buffer.byteLength(line) > maxLineBytes)
        throw new Error("The dictation request exceeds 64 KB.");
      const result = deferred<string>();
      this.pending = { id, result };
      timer = setTimeout(() => {
        void this.stop(new Error("Dictation processing exceeded its time limit."));
      }, timeoutMs);
      timer.unref();
      this.child.stdin.write(line);
      return await result.promise;
    } catch (error) {
      if (this.stopped) await this.closed.promise;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  stop(error: Error = abortError()): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      this.loaded = false;
      clearTimeout(this.loadTimer);
      this.ready.reject(error);
      this.pending?.result.reject(error);
      this.pending = undefined;
      this.buffer = Buffer.alloc(0);
      // Only kill the child captured at spawn. In-flight native inference cannot read a quit line.
      this.child.kill("SIGKILL");
      this.changed(false);
    }
    return this.closed.promise;
  }

  private receive(chunk: Buffer) {
    if (this.stopped) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      if (this.buffer.length + end - offset > maxLineBytes) {
        void this.stop(new Error("The dictation engine exceeded its response limit."));
        return;
      }
      this.buffer = Buffer.concat([this.buffer, chunk.subarray(offset, end)]);
      if (newline < 0) return;
      const line = this.buffer.toString("utf8");
      this.buffer = Buffer.alloc(0);
      offset = newline + 1;
      try {
        const event: unknown = JSON.parse(line);
        if (typeof event !== "object" || event === null || !("type" in event))
          throw new Error("Invalid engine response.");
        if (event.type === "ready" && !this.loaded && !this.pending) {
          clearTimeout(this.loadTimer);
          this.loaded = true;
          this.ready.resolve();
          this.changed(true);
          continue;
        }
        if (event.type === "error" && !("id" in event)) {
          throw new Error(
            "message" in event && typeof event.message === "string"
              ? event.message
              : "The dictation engine could not load.",
          );
        }
        if (!this.pending || !("id" in event) || event.id !== this.pending.id)
          throw new Error("The dictation engine returned an unexpected request ID.");
        if (
          event.type === "progress" &&
          "value" in event &&
          typeof event.value === "number" &&
          Number.isFinite(event.value) &&
          event.value >= 0 &&
          event.value <= 1
        )
          continue;
        if (
          event.type === "result" &&
          "text" in event &&
          typeof event.text === "string" &&
          !event.text.includes("\0") &&
          Buffer.byteLength(event.text) <= maxTextBytes
        ) {
          const pending = this.pending;
          this.pending = undefined;
          pending.result.resolve(event.text);
        } else if (
          event.type === "error" &&
          "message" in event &&
          typeof event.message === "string"
        ) {
          const pending = this.pending;
          this.pending = undefined;
          pending.result.reject(new Error(event.message));
        } else throw new Error("Invalid dictation engine response.");
      } catch (error) {
        void this.stop(
          error instanceof Error ? error : new Error("Invalid dictation engine response."),
        );
        return;
      }
    }
  }
}

/** Persistent Whisper and Qwen workers. The controller owns idle unloading and text fallback. */
export class DictationInference {
  private readonly options: DictationInferenceOptions;
  private readonly workers = new Map<DictationModelId, EngineProcess>();
  private disposed = false;
  private busy = false;
  private generation = 0;
  private unloading: Promise<void> | undefined;

  constructor(options: DictationInferenceOptions) {
    this.options = options;
  }

  get warmed(): boolean {
    return this.getLoadedModelIds().length > 0;
  }
  getLoadedModelIds(): DictationModelId[] {
    return [...this.workers].filter(([, worker]) => worker.isLoaded).map(([id]) => id);
  }

  transcribe(request: DictationTranscriptionRequest): Promise<string> {
    if (request.modelId === "qwen-cleanup")
      return Promise.reject(new Error("Select a speech model to transcribe audio."));
    const terms = this.preferredTerms(request.terms, 8192);
    return this.run(
      request.modelId,
      {
        type: "transcribe",
        path: request.audioPath,
        language: request.language,
        prompt: terms.join(", "),
      },
      request.signal,
    );
  }

  cleanup(request: DictationCleanupRequest): Promise<string> {
    if (!request.text.trim() || Buffer.byteLength(request.text) > maxTextBytes)
      return Promise.reject(new Error("The transcript is empty or exceeds the cleanup limit."));
    return this.run(
      "qwen-cleanup",
      {
        type: "correct",
        text: request.text,
        terms: this.preferredTerms(request.terms, 16384),
        language: request.language ?? "auto",
      },
      request.signal,
    );
  }

  unload(): Promise<void> {
    if (this.unloading) return this.unloading;
    this.generation += 1;
    const workers = [...this.workers.values()];
    this.workers.clear();
    this.unloading = Promise.all(workers.map((worker) => worker.stop()))
      .then(() => {})
      .finally(() => {
        this.unloading = undefined;
      });
    return this.unloading;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.unload();
  }

  private preferredTerms(terms: readonly string[], byteLimit: number) {
    const result: string[] = [];
    let bytes = 0;
    for (const term of terms) {
      const size = Buffer.byteLength(term);
      if (!term || term.includes("\0") || size > 256) continue;
      if (result.length >= 256 || bytes + size + 2 > byteLimit) break;
      result.push(term);
      bytes += size + 2;
    }
    return result;
  }

  private async run(
    id: DictationModelId,
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ) {
    if (this.disposed) throw new Error("Dictation inference has been disposed.");
    if (this.busy || this.unloading) throw new Error("Dictation inference is busy.");
    signal?.throwIfAborted();
    this.busy = true;
    const generation = this.generation;
    try {
      if (id !== "qwen-cleanup") {
        for (const [otherId, worker] of this.workers) {
          if (otherId !== "qwen-cleanup" && otherId !== id) {
            this.workers.delete(otherId);
            await worker.stop();
          }
        }
      }
      signal?.throwIfAborted();
      if (this.disposed || this.unloading || generation !== this.generation) throw abortError();
      let worker = this.workers.get(id);
      if (!worker) {
        const extension =
          (this.options.platform ?? HostProcessPlatform.defaultValue()) === "win32" ? ".exe" : "";
        const executable = NodePath.join(
          this.options.engineDirectory,
          `${id === "qwen-cleanup" ? "pathway-cleanup-engine" : "pathway-speech-engine"}${extension}`,
        );
        const args = [
          "--model",
          dictationModelPath(this.options.modelDirectory, id),
          "--device",
          this.options.device ?? "auto",
          "--parent-pid",
          String(process.pid),
        ];
        if (id !== "qwen-cleanup")
          args.push(
            "--vad-model",
            NodePath.join(this.options.modelDirectory, id, DICTATION_VAD_ARTIFACT.filename),
          );
        if (this.options.threads !== undefined)
          args.push("--threads", String(this.options.threads));
        const child = this.options.spawn
          ? this.options.spawn(executable, args)
          : NodeChildProcess.spawn(executable, args, {
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
            });
        const created = new EngineProcess(child, this.options.loadTimeoutMs ?? 120000, (loaded) => {
          if (!loaded && this.workers.get(id) === created) this.workers.delete(id);
          this.options.onLoadedChange?.(id, loaded);
          this.options.onChange?.();
        });
        worker = created;
        this.workers.set(id, worker);
      }
      const text = await worker.request(
        payload,
        signal,
        this.options.inferenceTimeoutMs ?? (id === "qwen-cleanup" ? 65000 : 300000),
      );
      signal?.throwIfAborted();
      if (generation !== this.generation) throw abortError();
      return text;
    } finally {
      this.busy = false;
    }
  }
}
