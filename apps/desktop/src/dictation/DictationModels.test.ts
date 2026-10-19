// @effect-diagnostics nodeBuiltinImport:off -- Tests use isolated temporary model directories.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DictationModels, type DictationModelManifest } from "./DictationModels.ts";

const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFS>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      reads.count++;
      return actual.createReadStream(...args);
    },
  };
});

const bytes = new TextEncoder().encode("ggml fixture weights");
const manifest: DictationModelManifest = {
  id: "whisper-base",
  name: "Whisper Base",
  kind: "speech",
  artifacts: [
    {
      filename: "ggml-base.bin",
      repository: "fixture/repository",
      revision: "fixture",
      bytes: bytes.byteLength,
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    },
  ],
};

const directories: string[] = [];
const managers: DictationModels[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  for (const directory of directories.splice(0))
    await NodeFSP.rm(directory, { recursive: true, force: true });
  reads.count = 0;
});

async function setup() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-models-"));
  directories.push(directory);
  return directory;
}

function launch(directory: string) {
  const statuses: string[] = [];
  const models: DictationModels = new DictationModels({
    directory,
    manifests: [manifest],
    onChange: () => statuses.push(models.getStates()[0]!.status),
    fetch: async () =>
      new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } }),
  });
  managers.push(models);
  return { models, statuses };
}

const modelFile = (directory: string) => NodePath.join(directory, "whisper-base", "ggml-base.bin");

describe("desktop dictation models", () => {
  it("hashes downloads once and trusts the verified marker on later launches", async () => {
    const directory = await setup();
    const first = launch(directory);
    await first.models.download("whisper-base");
    expect(first.models.isInstalled("whisper-base")).toBe(true);

    const second = launch(directory);
    await second.models.initialize();
    expect(second.models.isInstalled("whisper-base")).toBe(true);
    expect(second.statuses).toEqual(["installed"]);
    expect(reads.count).toBe(0);
  });

  it("hashes an unmarked install once, then records it", async () => {
    const directory = await setup();
    await NodeFSP.mkdir(NodePath.dirname(modelFile(directory)), { recursive: true });
    await NodeFSP.writeFile(modelFile(directory), bytes);

    const first = launch(directory);
    await first.models.initialize();
    expect(first.statuses).toEqual(["verifying", "installed"]);
    expect(reads.count).toBe(1);

    const second = launch(directory);
    await second.models.initialize();
    expect(second.models.isInstalled("whisper-base")).toBe(true);
    expect(reads.count).toBe(1);
  });

  it("rehashes and rejects same-size bytes changed after verification", async () => {
    const directory = await setup();
    await launch(directory).models.download("whisper-base");
    const info = await NodeFSP.stat(modelFile(directory));
    const tampered = bytes.map((byte, index) => (index === 0 ? byte ^ 1 : byte));
    await NodeFSP.writeFile(modelFile(directory), tampered);
    // Restoring the old mtime does not hide the write: ctime still moves.
    await NodeFSP.utimes(modelFile(directory), info.atime, info.mtime);

    const next = launch(directory);
    await next.models.initialize();
    expect(reads.count).toBe(1);
    expect(next.models.getStates()[0]).toMatchObject({
      status: "error",
      error: "The installed model failed verification. Remove it and download it again.",
    });
  });

  it("rejects a truncated model without hashing it", async () => {
    const directory = await setup();
    await launch(directory).models.download("whisper-base");
    await NodeFSP.truncate(modelFile(directory), 4);

    const next = launch(directory);
    await next.models.initialize();
    expect(next.models.getStates()[0]?.status).toBe("error");
    expect(reads.count).toBe(0);
  });

  it("rehashes when the marker was recorded for a different pinned checksum", async () => {
    const directory = await setup();
    await launch(directory).models.download("whisper-base");
    const markerPath = NodePath.join(directory, "whisper-base", ".verified.json");
    const marker = (await NodeFSP.readFile(markerPath, "utf8")).replace(
      manifest.artifacts[0]!.sha256,
      "0".repeat(64),
    );
    await NodeFSP.writeFile(markerPath, marker);

    const next = launch(directory);
    await next.models.initialize();
    expect(next.models.isInstalled("whisper-base")).toBe(true);
    expect(reads.count).toBe(1);
  });
});
