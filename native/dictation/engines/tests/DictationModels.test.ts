import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DictationModels,
  DICTATION_MODEL_MANIFESTS,
  type DictationModelManifest,
} from "../../../../apps/desktop/src/dictation/DictationModels.ts";

const contents = [Buffer.from("speech fixture"), Buffer.from("vad fixture")];
const manifest: DictationModelManifest = {
  id: "whisper-base",
  name: "Test speech",
  kind: "speech",
  artifacts: contents.map((bytes, index) => ({
    filename: `fixture-${index}.bin`,
    repository: "fixture/models",
    revision: "a".repeat(40),
    bytes: bytes.length,
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
  })),
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  vi.restoreAllMocks();
});

async function setup(fetcher?: typeof fetch, onChange = () => {}, inUse = () => false) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-model-test-"));
  cleanups.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const transport = vi.fn<typeof fetch>(
    fetcher ??
      (async (url) => {
        const index = String(url).endsWith("fixture-0.bin") ? 0 : 1;
        return new Response(contents[index]!);
      }),
  );
  const models = new DictationModels({
    directory,
    onChange,
    isModelInUse: inUse,
    manifests: [manifest],
    fetch: transport,
  });
  cleanups.push(() => models.dispose());
  return { directory, models, transport };
}

describe("DictationModels", () => {
  it("throttles chunk progress while preserving artifact and terminal updates", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const changed = vi.fn();
    const { models } = await setup(async (url) => {
      const bytes = contents[String(url).endsWith("fixture-0.bin") ? 0 : 1]!;
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        }),
      );
    }, changed);
    await models.download("whisper-base");
    expect(changed).toHaveBeenCalledTimes(6);
    expect(models.getStates()[0]?.downloadedBytes).toBe(25);
  });
  it("pins the multilingual model artifacts and makes Silero an explicit speech download", () => {
    expect(DICTATION_MODEL_MANIFESTS.map((item) => item.artifacts[0]?.bytes)).toEqual([
      147951465, 487601967, 1624555275, 2497281120,
    ]);
    for (const model of DICTATION_MODEL_MANIFESTS)
      for (const file of model.artifacts) {
        expect(file.revision).toMatch(/^[0-9a-f]{40}$/);
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    expect(
      DICTATION_MODEL_MANIFESTS.slice(0, 3).every((item) => item.artifacts[1]?.bytes === 885098),
    ).toBe(true);
  });

  it("initializes without networking and publishes only a fully verified speech/VAD directory", async () => {
    const { directory, models, transport } = await setup();
    await models.initialize();
    expect(transport).not.toHaveBeenCalled();
    expect(models.isInstalled("whisper-base")).toBe(false);
    await models.download("whisper-base");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(await NodeFSP.readdir(directory)).toEqual(["whisper-base"]);
    expect(await NodeFSP.readFile(models.modelPath("whisper-base"))).toEqual(contents[0]);
    expect(models.getStates()[0]).toMatchObject({
      status: "installed",
      downloadedBytes: 25,
      bytes: 25,
    });
    await models.download("whisper-base");
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("rejects a same-size SHA-256 mismatch and leaves no installed or partial files", async () => {
    const { directory, models } = await setup(
      async () => new Response(Buffer.alloc(contents[0]!.length, 120)),
    );
    await expect(models.download("whisper-base")).rejects.toThrow("verification");
    expect(models.getStates()[0]?.status).toBe("error");
    expect(await NodeFSP.readdir(directory)).toEqual([]);
  });

  it.each(["short", "long", "header", "http"])("rejects an invalid %s response", async (mode) => {
    const { directory, models } = await setup(async () =>
      mode === "http"
        ? new Response("failure", { status: 503 })
        : new Response(
            Buffer.alloc(mode === "long" ? 100 : 2),
            mode === "header" ? { headers: { "content-length": "999" } } : {},
          ),
    );
    await expect(models.download("whisper-base")).rejects.toThrow();
    expect(await NodeFSP.readdir(directory)).toEqual([]);
    expect(models.isInstalled("whisper-base")).toBe(false);
  });

  it("cancels an in-flight stream, waits for cleanup, and safely retries", async () => {
    const entered = Promise.withResolvers<void>();
    let stalled = true;
    const { directory, models } = await setup(async (url) => {
      if (stalled) {
        entered.resolve();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(contents[0]!.subarray(0, 3));
            },
          }),
        );
      }
      return new Response(contents[String(url).endsWith("fixture-0.bin") ? 0 : 1]!);
    });
    const transfer = models.download("whisper-base");
    const rejected = expect(transfer).rejects.toMatchObject({ name: "AbortError" });
    await entered.promise;
    await models.cancel("whisper-base");
    await rejected;
    expect(await NodeFSP.readdir(directory)).toEqual([]);
    expect(models.getStates()[0]?.status).toBe("missing");
    stalled = false;
    await models.download("whisper-base");
    expect(models.isInstalled("whisper-base")).toBe(true);
  });

  it("honors cancellation before initialization finishes", async () => {
    const { models, transport, directory } = await setup();
    const transfer = models.download("whisper-base");
    const rejected = expect(transfer).rejects.toMatchObject({ name: "AbortError" });
    await models.cancel("whisper-base");
    await rejected;
    expect(transport).not.toHaveBeenCalled();
    expect(await NodeFSP.readdir(directory)).toEqual([]);
  });

  it("does not publish when cancelled at verification", async () => {
    const fixture = await setup(undefined, () => {
      if (fixture.models.getStates()[0]?.status === "verifying")
        void fixture.models.cancel("whisper-base");
    });
    await expect(fixture.models.download("whisper-base")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(await NodeFSP.readdir(fixture.directory)).toEqual([]);
  });

  it("verifies existing bytes and rejects corruption without networking", async () => {
    const { directory, models, transport } = await setup();
    await NodeFSP.mkdir(NodePath.join(directory, "whisper-base"));
    for (const [index, bytes] of contents.entries())
      await NodeFSP.writeFile(
        NodePath.join(directory, "whisper-base", `fixture-${index}.bin`),
        index === 0 ? Buffer.alloc(bytes.length) : bytes,
      );
    await models.initialize();
    expect(models.getStates()[0]?.status).toBe("error");
    expect(transport).not.toHaveBeenCalled();
    await models.download("whisper-base");
    expect(models.isInstalled("whisper-base")).toBe(true);
  });

  it("blocks active and loaded model removal, and permits removal after unload", async () => {
    let active = false;
    const { models, directory } = await setup(undefined, undefined, () => active);
    await models.download("whisper-base");
    active = true;
    expect(() => models.remove("whisper-base")).toThrow("Stop dictation");
    active = false;
    models.setLoaded("whisper-base", true);
    expect(() => models.remove("whisper-base")).toThrow("unload");
    models.setLoaded("whisper-base", false);
    await models.remove("whisper-base");
    expect(await NodeFSP.readdir(directory)).toEqual([]);
    expect(models.isInstalled("whisper-base")).toBe(false);
  });

  it("removal cancels a transfer and does not delete unrelated files", async () => {
    const entered = Promise.withResolvers<void>();
    const { models, directory } = await setup(async () => {
      entered.resolve();
      return new Response(new ReadableStream());
    });
    const transfer = models.download("whisper-base");
    const rejected = expect(transfer).rejects.toThrow();
    await entered.promise;
    await NodeFSP.writeFile(NodePath.join(directory, "unrelated.txt"), "keep");
    await models.remove("whisper-base");
    await rejected;
    expect(await NodeFSP.readdir(directory)).toEqual(["unrelated.txt"]);
  });
});
