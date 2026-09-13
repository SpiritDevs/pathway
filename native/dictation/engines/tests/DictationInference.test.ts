import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DictationInference } from "../../../../apps/desktop/src/dictation/DictationInference.ts";

const fixture = NodeURL.fileURLToPath(new URL("./fixture-engine.mjs", import.meta.url));
const instances: DictationInference[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
  vi.useRealTimers();
});
const request = (audioPath = "valid") => ({
  audioPath,
  modelId: "whisper-base" as const,
  language: "auto",
  terms: [],
});

function setup(cold = false) {
  const received = Promise.withResolvers<void>();
  const childSpawn = vi.fn((_: string, args: string[]) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [fixture, ...(cold ? ["--fixture-cold"] : []), ...args],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stderr.once("data", () => received.resolve());
    return child;
  });
  const loaded = vi.fn();
  const inference = new DictationInference({
    engineDirectory: "/fixture/engines",
    modelDirectory: "/fixture/models",
    spawn: childSpawn,
    onLoadedChange: loaded,
  });
  instances.push(inference);
  return { inference, childSpawn, loaded, received };
}

describe("DictationInference", () => {
  it("passes an explicit cleanup language and defaults to auto for older callers", async () => {
    const { inference } = setup();
    expect(await inference.cleanup({ text: "echo-language", terms: [], language: "fr" })).toBe(
      "fr",
    );
    expect(await inference.cleanup({ text: "echo-language", terms: [], language: "es" })).toBe(
      "es",
    );
    expect(await inference.cleanup({ text: "echo-language", terms: [] })).toBe("auto");
  });
  it("reuses a warmed process and decodes fragmented UTF-8 responses", async () => {
    const { inference, childSpawn } = setup();
    expect(inference.warmed).toBe(false);
    expect(await inference.transcribe(request())).toBe("Olá, 世界!");
    expect(await inference.transcribe(request())).toBe("Olá, 世界!");
    expect(inference.getLoadedModelIds()).toEqual(["whisper-base"]);
    expect(childSpawn).toHaveBeenCalledTimes(1);
    expect(childSpawn.mock.calls[0]?.[1]).toContain("--vad-model");
    await inference.unload();
    expect(inference.warmed).toBe(false);
  });

  it.each([false, true])(
    "cancels during %s cold startup and suppresses stale output",
    async (cold) => {
      const { inference, received, childSpawn } = setup(cold);
      const controller = new AbortController();
      const operation = inference.transcribe({ ...request("hang"), signal: controller.signal });
      const rejected = expect(operation).rejects.toMatchObject({ name: "AbortError" });
      await received.promise;
      controller.abort();
      await rejected;
      expect(inference.warmed).toBe(false);
      const child = childSpawn.mock.results[0]?.value;
      expect(child?.signalCode).toBe("SIGKILL");
      if (!cold) expect(await inference.transcribe(request())).toBe("Olá, 世界!");
    },
  );

  it.each(["wrong-id", "oversized", "malformed", "crash"])(
    "rejects %s protocol failure and restarts cleanly",
    async (mode) => {
      const { inference, childSpawn } = setup();
      await expect(inference.transcribe(request(mode))).rejects.toThrow();
      expect(inference.warmed).toBe(false);
      expect(await inference.transcribe(request())).toBe("Olá, 世界!");
      expect(childSpawn).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps a valid worker after a request-level error and keeps cleanup separate", async () => {
    const { inference, childSpawn } = setup();
    await expect(inference.transcribe(request("error"))).rejects.toThrow("Fixture decode failed");
    expect(inference.warmed).toBe(true);
    await inference.transcribe(request());
    await inference.cleanup({ text: "hello", terms: ["Pathway"] });
    expect(childSpawn).toHaveBeenCalledTimes(2);
    expect(inference.getLoadedModelIds()).toEqual(["whisper-base", "qwen-cleanup"]);
    await inference.unload();
    expect(inference.getLoadedModelIds()).toEqual([]);
  });

  it("switches speech models and fully closes the previous process", async () => {
    const { inference, childSpawn } = setup();
    await inference.transcribe(request());
    await inference.transcribe({ ...request(), modelId: "whisper-small" });
    expect(childSpawn.mock.results[0]?.value.signalCode).toBe("SIGKILL");
    expect(inference.getLoadedModelIds()).toEqual(["whisper-small"]);
  });

  it("unloading during a model switch prevents a replacement process from starting", async () => {
    const { inference, childSpawn } = setup();
    await inference.transcribe(request());
    const switching = inference.transcribe({ ...request(), modelId: "whisper-small" });
    const rejected = expect(switching).rejects.toMatchObject({ name: "AbortError" });
    await inference.unload();
    await rejected;
    expect(childSpawn).toHaveBeenCalledTimes(1);
    expect(inference.warmed).toBe(false);
  });

  it("terminates a stalled request at the deadline without polling", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { inference, received } = setup();
    const operation = inference.transcribe(request("hang"));
    const rejected = expect(operation).rejects.toThrow("time limit");
    await received.promise;
    await vi.advanceTimersByTimeAsync(300000);
    await rejected;
    expect(inference.warmed).toBe(false);
  });

  it("rejects overlapping work and does not spawn for a pre-cancelled request", async () => {
    const { inference, received, childSpawn } = setup();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      inference.transcribe({ ...request(), signal: cancelled.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(childSpawn).not.toHaveBeenCalled();
    const operation = inference.transcribe(request("hang"));
    const rejected = expect(operation).rejects.toMatchObject({ name: "AbortError" });
    await received.promise;
    await expect(inference.cleanup({ text: "hi", terms: [] })).rejects.toThrow("busy");
    await inference.unload();
    await rejected;
    await inference.dispose();
    await expect(inference.transcribe(request())).rejects.toThrow("disposed");
  });
});
