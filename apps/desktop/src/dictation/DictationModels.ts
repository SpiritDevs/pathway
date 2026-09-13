// @effect-diagnostics nodeBuiltinImport:off -- This desktop boundary streams verified model files into its isolated directory.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { DictationModelId, DictationModelState } from "@spiritdevs/contracts/dictation";

export interface DictationModelArtifact {
  readonly filename: string;
  readonly repository: string;
  readonly revision: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface DictationModelManifest {
  readonly id: DictationModelId;
  readonly name: string;
  readonly kind: "speech" | "cleanup";
  /** The first artifact is the inference model; speech models also require Silero. */
  readonly artifacts: readonly DictationModelArtifact[];
}

// Source: each repository's /api/models/{repository}/tree/{revision} LFS oid and size.
// Verified against the publishers on 2026-09-12. Never resolve a mutable branch at runtime.
export const DICTATION_VAD_ARTIFACT: DictationModelArtifact = {
  filename: "ggml-silero-v6.2.0.bin",
  repository: "ggml-org/whisper-vad",
  revision: "9ffd54a1e1ee413ddf265af9913beaf518d1639b",
  bytes: 885098,
  sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
};

const speechArtifact = (
  filename: string,
  bytes: number,
  sha256: string,
): DictationModelArtifact => ({
  filename,
  bytes,
  sha256,
  repository: "ggerganov/whisper.cpp",
  revision: "5359861c739e955e79d9a303bcbc70fb988958b1",
});

export const DICTATION_MODEL_MANIFESTS: readonly DictationModelManifest[] = [
  {
    id: "whisper-base",
    name: "Whisper Base",
    kind: "speech",
    artifacts: [
      speechArtifact(
        "ggml-base.bin",
        147951465,
        "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
      ),
      DICTATION_VAD_ARTIFACT,
    ],
  },
  {
    id: "whisper-small",
    name: "Whisper Small",
    kind: "speech",
    artifacts: [
      speechArtifact(
        "ggml-small.bin",
        487601967,
        "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
      ),
      DICTATION_VAD_ARTIFACT,
    ],
  },
  {
    id: "whisper-turbo",
    name: "Whisper large-v3-turbo",
    kind: "speech",
    artifacts: [
      speechArtifact(
        "ggml-large-v3-turbo.bin",
        1624555275,
        "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
      ),
      DICTATION_VAD_ARTIFACT,
    ],
  },
  {
    id: "qwen-cleanup",
    name: "Qwen3-4B-Instruct-2507",
    kind: "cleanup",
    artifacts: [
      {
        filename: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        repository: "unsloth/Qwen3-4B-Instruct-2507-GGUF",
        revision: "a06e946bb6b655725eafa393f4a9745d460374c9",
        bytes: 2497281120,
        sha256: "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597",
      },
    ],
  },
];

export function dictationModelPath(directory: string, id: DictationModelId): string {
  const manifest = DICTATION_MODEL_MANIFESTS.find((entry) => entry.id === id);
  if (!manifest?.artifacts[0]) throw new Error("Unknown dictation model.");
  return NodePath.join(directory, id, manifest.artifacts[0].filename);
}

export interface DictationModelsOptions {
  directory: string;
  onChange: () => void;
  /** The controller owns recording/model-use policy. Removal checks this before deleting. */
  isModelInUse?: (id: DictationModelId) => boolean;
  /** Fixtures may replace the manifest and transport; production uses the pinned catalog. */
  manifests?: readonly DictationModelManifest[];
  fetch?: typeof globalThis.fetch;
}

type Transfer = { controller: AbortController; promise: Promise<void> };
const missing = (manifest: DictationModelManifest): DictationModelState => ({
  id: manifest.id,
  name: manifest.name,
  kind: manifest.kind,
  bytes: manifest.artifacts.reduce((sum, file) => sum + file.bytes, 0),
  status: "missing",
  downloadedBytes: 0,
  loaded: false,
  error: null,
});
const isMissing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** Explicit, verified installation into the supplied desktop data directory. No automatic networking. */
export class DictationModels {
  private readonly manifests: readonly DictationModelManifest[];
  private readonly states = new Map<DictationModelId, DictationModelState>();
  private readonly transfers = new Map<DictationModelId, Transfer>();
  private readonly removals = new Map<DictationModelId, Promise<void>>();
  private readonly lifetime = new AbortController();
  private initialization?: Promise<void>;
  private disposed = false;
  private readonly options: DictationModelsOptions;

  constructor(options: DictationModelsOptions) {
    this.options = options;
    this.manifests = options.manifests ?? DICTATION_MODEL_MANIFESTS;
    for (const manifest of this.manifests) this.states.set(manifest.id, missing(manifest));
  }

  initialize(): Promise<void> {
    this.assertAlive();
    return (this.initialization ??= this.inspect());
  }

  getStates(): DictationModelState[] {
    return [...this.states.values()].map((state) => ({ ...state }));
  }
  isInstalled(id: DictationModelId): boolean {
    return this.states.get(id)?.status === "installed";
  }
  modelPath(id: DictationModelId): string {
    const file = this.manifest(id).artifacts[0];
    if (!file) throw new Error("The model has no artifacts.");
    return NodePath.join(this.options.directory, id, file.filename);
  }

  /** Keep the DTO's loaded indicator aligned with the inference workers. */
  setLoaded(id: DictationModelId, loaded: boolean): void {
    this.update(id, { loaded });
  }

  download(id: DictationModelId): Promise<void> {
    this.assertAlive();
    this.manifest(id);
    if (this.removals.has(id)) return Promise.reject(new Error("The model is being removed."));
    const current = this.transfers.get(id);
    if (current)
      return current.controller.signal.aborted
        ? current.promise.catch(() => {}).then(() => this.download(id))
        : current.promise;
    const controller = new AbortController();
    const transfer = { controller, promise: Promise.resolve() };
    // Reserve the ID before inspection so immediate cancellation also cancels a cold download.
    this.transfers.set(id, transfer);
    transfer.promise = this.install(id, controller.signal).finally(() => {
      if (this.transfers.get(id) === transfer) this.transfers.delete(id);
    });
    return transfer.promise;
  }

  async cancel(id: DictationModelId): Promise<void> {
    const transfer = this.transfers.get(id);
    transfer?.controller.abort();
    await transfer?.promise.catch(() => {});
  }

  remove(id: DictationModelId): Promise<void> {
    this.assertAlive();
    this.manifest(id);
    this.assertUnused(id);
    const current = this.removals.get(id);
    if (current) return current;
    const operation = this.removeFiles(id).finally(() => {
      this.removals.delete(id);
    });
    this.removals.set(id, operation);
    return operation;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.lifetime.abort();
    for (const transfer of this.transfers.values()) transfer.controller.abort();
    await Promise.allSettled([
      this.initialization,
      ...[...this.transfers.values()].map((job) => job.promise),
      ...this.removals.values(),
    ]);
  }

  private assertAlive() {
    if (this.disposed) throw new Error("Dictation models have been disposed.");
  }
  private assertUnused(id: DictationModelId) {
    if (this.states.get(id)?.loaded || this.options.isModelInUse?.(id))
      throw new Error("Stop dictation and unload this model before removing it.");
  }
  private manifest(id: DictationModelId) {
    const result = this.manifests.find((manifest) => manifest.id === id);
    if (!result) throw new Error("Unknown dictation model.");
    return result;
  }
  private update(id: DictationModelId, patch: Partial<DictationModelState>) {
    const state = this.states.get(id);
    if (!state) return;
    this.states.set(id, { ...state, ...patch });
    if (!this.disposed) this.options.onChange();
  }

  private async inspect() {
    await NodeFSP.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    // The supplied directory belongs to this manager. Clean only our abandoned staging folders.
    for (const entry of await NodeFSP.readdir(this.options.directory)) {
      if (/^\.dictation-download-[0-9a-f-]{36}$/.test(entry))
        await NodeFSP.rm(NodePath.join(this.options.directory, entry), {
          recursive: true,
          force: true,
        });
    }
    for (const manifest of this.manifests) {
      this.lifetime.signal.throwIfAborted();
      try {
        const directory = NodePath.join(this.options.directory, manifest.id);
        const info = await NodeFSP.lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error("The installed model must be a regular directory.");
        this.update(manifest.id, { status: "verifying", error: null });
        for (const file of manifest.artifacts)
          await this.verify(NodePath.join(directory, file.filename), file, this.lifetime.signal);
        this.update(manifest.id, { status: "installed", downloadedBytes: missing(manifest).bytes });
      } catch (error) {
        this.lifetime.signal.throwIfAborted();
        this.update(manifest.id, {
          status: isMissing(error) ? "missing" : "error",
          error: isMissing(error)
            ? null
            : "The installed model failed verification. Remove it and download it again.",
        });
      }
    }
  }

  private async verify(filename: string, file: DictationModelArtifact, signal: AbortSignal) {
    const info = await NodeFSP.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes)
      throw new Error("Model size does not match the manifest.");
    const hash = NodeCrypto.createHash("sha256");
    const stream = NodeFS.createReadStream(filename, { signal });
    for await (const chunk of stream) hash.update(chunk);
    signal.throwIfAborted();
    if (hash.digest("hex") !== file.sha256)
      throw new Error("Model SHA-256 does not match the manifest.");
  }

  private async install(id: DictationModelId, signal: AbortSignal) {
    const manifest = this.manifest(id);
    let staging: string | undefined;
    let started = false;
    try {
      await this.initialize();
      signal.throwIfAborted();
      this.assertAlive();
      if (this.isInstalled(id)) return;
      this.assertUnused(id);
      started = true;
      staging = NodePath.join(
        this.options.directory,
        `.dictation-download-${NodeCrypto.randomUUID()}`,
      );
      await NodeFSP.mkdir(staging, { mode: 0o700 });
      this.update(id, { status: "downloading", downloadedBytes: 0, error: null });
      let completed = 0;
      let lastProgress = performance.now();
      for (const file of manifest.artifacts) {
        await this.downloadFile(file, NodePath.join(staging, file.filename), signal, (bytes) => {
          if (performance.now() - lastProgress < 200) return;
          lastProgress = performance.now();
          this.update(id, { downloadedBytes: completed + bytes });
        });
        completed += file.bytes;
        this.update(id, { downloadedBytes: completed });
      }
      this.update(id, { status: "verifying" });
      signal.throwIfAborted();
      this.assertAlive();
      // Hashes are checked as bytes stream to disk. The complete folder is published in one rename.
      const destination = NodePath.join(this.options.directory, id);
      await NodeFSP.rm(destination, { recursive: true, force: true });
      signal.throwIfAborted();
      await NodeFSP.rename(staging, destination);
      // A cancellation racing rename must not publish a late installation.
      if (signal.aborted || this.disposed) {
        await NodeFSP.rm(destination, { recursive: true, force: true });
        signal.throwIfAborted();
        this.assertAlive();
      }
      this.update(id, { status: "installed", downloadedBytes: completed, error: null });
    } catch (error) {
      if (started)
        this.update(id, {
          status: signal.aborted || this.disposed ? "missing" : "error",
          downloadedBytes: 0,
          error:
            signal.aborted || this.disposed
              ? null
              : error instanceof Error
                ? error.message
                : "Model download failed.",
        });
      throw error;
    } finally {
      if (staging) await NodeFSP.rm(staging, { recursive: true, force: true });
    }
  }

  private async downloadFile(
    file: DictationModelArtifact,
    filename: string,
    signal: AbortSignal,
    progress: (bytes: number) => void,
  ) {
    signal.throwIfAborted();
    const url = `https://huggingface.co/${file.repository}/resolve/${file.revision}/${file.filename}`;
    const response = await (this.options.fetch ?? globalThis.fetch)(url, {
      signal,
      redirect: "follow",
      headers: { "Accept-Encoding": "identity" },
    });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error(`Model download failed (HTTP ${response.status}). Retry the download.`);
    }
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) !== file.bytes) {
      await response.body.cancel();
      throw new Error("Model download size does not match the manifest.");
    }
    const reader = response.body.getReader();
    const onAbort = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let output: Awaited<ReturnType<typeof NodeFSP.open>> | undefined;
    try {
      output = await NodeFSP.open(filename, "wx", 0o600);
      const hash = NodeCrypto.createHash("sha256");
      let bytes = 0;
      while (true) {
        signal.throwIfAborted();
        const result = await reader.read();
        signal.throwIfAborted();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > file.bytes) throw new Error("Model download exceeds the manifest size.");
        hash.update(result.value);
        let offset = 0;
        while (offset < result.value.byteLength) {
          signal.throwIfAborted();
          const written = await output.write(
            result.value,
            offset,
            result.value.byteLength - offset,
          );
          if (written.bytesWritten === 0) throw new Error("Could not write the model download.");
          offset += written.bytesWritten;
        }
        progress(bytes);
      }
      if (bytes !== file.bytes || hash.digest("hex") !== file.sha256)
        throw new Error("Model download failed SHA-256 or size verification. Retry the download.");
      await output.sync();
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener("abort", onAbort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      await output?.close();
    }
  }

  private async removeFiles(id: DictationModelId) {
    await this.cancel(id);
    await this.initialize();
    this.assertUnused(id);
    await NodeFSP.rm(NodePath.join(this.options.directory, id), { recursive: true, force: true });
    this.update(id, missing(this.manifest(id)));
  }
}
