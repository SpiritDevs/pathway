// @effect-diagnostics nodeBuiltinImport:off -- Tests use isolated temporary desktop files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DictationController,
  type DictationControllerOptions,
  type DictationInferencePort,
  type DictationNativePort,
} from "./DictationController.ts";
import { DictationStorage } from "./DictationStorage.ts";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});
function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function setup(
  overrides: Partial<DictationInferencePort> = {},
  options: {
    native?: Partial<DictationNativePort>;
    models?: Partial<DictationControllerOptions["models"]>;
    onState?: DictationControllerOptions["onState"];
    prepare?: (directory: string, storage: DictationStorage) => Promise<void>;
    enable?: boolean;
  } = {},
) {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "pathway-dictation-controller-"),
  );
  const storage = new DictationStorage(directory);
  await options.prepare?.(directory, storage);
  let captureId = "";
  const insert = vi.fn(async (_text: string) => ({ status: "inserted" as const }));
  const onMeter = vi.fn();
  const controller = new DictationController({
    platform: "darwin",
    arch: "arm64",
    nativeAvailable: true,
    temporaryDirectory: NodePath.join(directory, "temporary"),
    storage,
    models: {
      initialize: async () => {},
      getStates: () => [],
      isInstalled: () => true,
      download: async () => {},
      cancel: async () => {},
      remove: async () => {},
      dispose: async () => {},
      ...options.models,
    },
    native: {
      permissions: async () => ({ microphone: "granted", accessibility: "granted" }),
      microphones: async () => [],
      configure: async () => {},
      start: async (id, file) => {
        captureId = id;
        await NodeFSP.writeFile(file, "audio fixture");
      },
      stop: async () => ({ durationMs: 1200 }),
      cancel: async () => {},
      insert,
      close: async () => {},
      ...options.native,
    },
    inference: {
      transcribe: async () => "Hello from path way.",
      cleanup: async () => "Hello from Pathway.",
      unload: async () => {},
      ...overrides,
    },
    onState: options.onState ?? (() => {}),
    onMeter,
    copy: () => {},
    open: () => {},
  });
  disposals.push(async () => {
    await controller.dispose();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  });
  await controller.execute({ type: "account", accountId: "first-account" });
  if (options.enable !== false)
    await controller.execute({
      type: "preferences",
      preferences: { ...controller.getState().preferences, setupComplete: true, enabled: true },
    });
  return { controller, storage, insert, onMeter, directory, captureId: () => captureId };
}

describe("desktop dictation lifecycle", () => {
  it("clears a failed model download banner when retrying and after the retry succeeds", async () => {
    const retried = deferred<void>();
    const failed = deferred<void>();
    const completed = deferred<void>();
    let completing = false;
    const download = vi
      .fn<DictationControllerOptions["models"]["download"]>()
      .mockRejectedValueOnce(new Error("Download interrupted"))
      .mockReturnValueOnce(retried.promise);
    const { controller } = await setup(
      {},
      {
        models: { download },
        onState: (state) => {
          if (state.error === "Download interrupted") failed.resolve();
          if (completing) completed.resolve();
        },
      },
    );
    await controller.execute({ type: "download", modelId: "whisper-turbo" });
    await failed.promise;
    expect(controller.getState().error).toBe("Download interrupted");

    const retryState = await controller.execute({ type: "download", modelId: "whisper-turbo" });
    expect(retryState.error).toBeNull();
    completing = true;
    retried.resolve();
    await completed.promise;
    expect(controller.getState().error).toBeNull();
    expect(download).toHaveBeenNthCalledWith(2, "whisper-turbo");
  });

  it("keeps a newer download failure when another model finishes downloading", async () => {
    const speechDownloaded = deferred<void>();
    const cleanupFailed = deferred<void>();
    const completed = deferred<void>();
    let completing = false;
    const download = vi
      .fn<DictationControllerOptions["models"]["download"]>()
      .mockReturnValueOnce(speechDownloaded.promise)
      .mockRejectedValueOnce(new Error("Cleanup model download failed"));
    const { controller } = await setup(
      {},
      {
        models: { download },
        onState: (state) => {
          if (state.error === "Cleanup model download failed") cleanupFailed.resolve();
          if (completing) completed.resolve();
        },
      },
    );
    await controller.execute({ type: "download", modelId: "whisper-turbo" });
    await controller.execute({ type: "download", modelId: "qwen-cleanup" });
    await cleanupFailed.promise;
    completing = true;
    speechDownloaded.resolve();
    await completed.promise;
    expect(controller.getState().error).toBe("Cleanup model download failed");
  });

  it("updates the current recording meter and ignores a cancelled session's late events", async () => {
    const { controller, captureId, onMeter } = await setup();
    await controller.start("locked");
    const previousId = captureId();
    controller.meter(previousId, 1500, 0.7);
    expect(controller.getState()).toMatchObject({ durationMs: 1500, level: 0.7 });
    expect(onMeter).toHaveBeenCalledExactlyOnceWith({
      durationMs: 1500,
      level: 0.7,
      mode: "locked",
    });

    await controller.cancel();
    controller.meter(previousId, 2000, 0.9);
    expect(controller.getState()).toMatchObject({ durationMs: 0, level: 0 });
    await controller.start("hold");
    controller.meter(previousId, 2500, 0.9);
    expect(controller.getState()).toMatchObject({ durationMs: 0, level: 0 });
    expect(onMeter).toHaveBeenCalledTimes(1);

    controller.meter(captureId(), 500, 0.4);
    expect(controller.getState()).toMatchObject({ durationMs: 500, level: 0.4 });
    expect(onMeter).toHaveBeenLastCalledWith({ durationMs: 500, level: 0.4, mode: "hold" });
  });

  it("does not replace a new recording with a previous native failure", async () => {
    const cancelling = deferred<void>();
    const cancelled = deferred<void>();
    const cancel = vi.fn(async () => {});
    const { controller } = await setup({}, { native: { cancel } });
    await controller.start("locked");
    cancel.mockImplementationOnce(async () => {
      cancelling.resolve();
      await cancelled.promise;
    });
    const failed = controller.nativeFailed("The previous microphone stopped.");
    await cancelling.promise;
    const restarted = controller.start("locked");
    cancelled.resolve();
    await Promise.all([failed, restarted]);
    expect(controller.getState()).toMatchObject({ phase: "recording", error: null });
  });

  it("finishes once when the shortcut is released before the microphone starts", async () => {
    const starting = deferred<void>();
    const microphoneReady = deferred<void>();
    const transcribing = deferred<void>();
    const transcript = deferred<string>();
    const stopCapture = vi.fn(async () => ({ durationMs: 1200 }));
    const transcribe = vi.fn(() => {
      transcribing.resolve();
      return transcript.promise;
    });
    const { controller, insert } = await setup(
      { transcribe },
      {
        native: {
          start: async () => {
            starting.resolve();
            await microphoneReady.promise;
          },
          stop: stopCapture,
        },
      },
    );
    const start = controller.start("hold");
    await starting.promise;
    const completion = controller.stop();
    expect(controller.getState().phase).toBe("processing");
    microphoneReady.resolve();
    await start;
    await transcribing.promise;
    const phaseWhileTranscribing = controller.getState().phase;
    const repeatedStop = controller.stop();
    transcript.resolve("Hello from Pathway.");
    await Promise.all([completion, repeatedStop]);
    expect(phaseWhileTranscribing).toBe("processing");
    expect(stopCapture).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(await controller.listHistory()).toHaveLength(1);
  });

  it("clears orphaned recordings before admitting a new session", async () => {
    const orphan = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.wav";
    const { controller, directory } = await setup(
      {},
      {
        prepare: async (root) => {
          const temporary = NodePath.join(root, "temporary");
          await NodeFSP.mkdir(temporary);
          await NodeFSP.writeFile(
            NodePath.join(temporary, orphan),
            "speech left by a crashed process",
          );
          await NodeFSP.writeFile(
            NodePath.join(temporary, "unrelated.txt"),
            "leave this file alone",
          );
        },
      },
    );
    expect(await NodeFSP.readdir(NodePath.join(directory, "temporary"))).toEqual(["unrelated.txt"]);
    await controller.start("hold");
    await controller.stop();
    expect(controller.getState().result?.text).toBe("Hello from Pathway.");
    expect(await NodeFSP.readdir(NodePath.join(directory, "temporary"))).toEqual(["unrelated.txt"]);
  });

  it("waits for native shutdown before configuring a different account", async () => {
    const closing = deferred<void>();
    const closed = deferred<void>();
    const close = vi.fn(async () => {});
    const permissions = vi.fn(async () => ({
      microphone: "granted" as const,
      accessibility: "granted" as const,
    }));
    const { controller } = await setup({}, { native: { close, permissions } });
    const readsBeforeSwitch = permissions.mock.calls.length;
    close.mockImplementationOnce(async () => {
      closing.resolve();
      await closed.promise;
    });
    const switching = controller.execute({ type: "account", accountId: "second-account" });
    await closing.promise;
    expect(controller.getState().authenticated).toBe(false);
    expect(permissions).toHaveBeenCalledTimes(readsBeforeSwitch);
    closed.resolve();
    await switching;
    expect(permissions).toHaveBeenCalledTimes(readsBeforeSwitch + 1);
    expect(controller.getState().authenticated).toBe(true);
  });

  it("never inserts or archives a response that arrives after cancellation", async () => {
    const entered = deferred<void>();
    const transcript = deferred<string>();
    const { controller, insert, directory } = await setup({
      transcribe: () => {
        entered.resolve();
        return transcript.promise;
      },
    });
    await controller.start("locked");
    const completion = controller.stop();
    await entered.promise;
    await controller.cancel();
    transcript.resolve("This must not be inserted.");
    await completion;
    expect(insert).not.toHaveBeenCalled();
    expect(await controller.listHistory()).toEqual([]);
    expect(await NodeFSP.readdir(NodePath.join(directory, "temporary"))).toEqual([]);
    expect(controller.getState().phase).toBe("idle");
  });

  it("isolates accounts and discards in-flight work when the account changes", async () => {
    const entered = deferred<void>();
    const transcript = deferred<string>();
    const { controller, insert, storage } = await setup({
      transcribe: () => {
        entered.resolve();
        return transcript.promise;
      },
    });
    await controller.start("hold");
    const completion = controller.stop();
    await entered.promise;
    await controller.execute({ type: "account", accountId: "second-account" });
    transcript.resolve("Private text from the first account.");
    await completion;
    expect(insert).not.toHaveBeenCalled();
    expect(controller.getState().result).toBeNull();
    expect(await storage.history("first-account")).toEqual([]);
    expect(await controller.listHistory()).toEqual([]);
    await controller.execute({ type: "account", accountId: null });
    await expect(controller.start("locked")).rejects.toThrow("Sign in");
  });

  it("delivers the usable transcript when cleanup fails and removes the recording", async () => {
    const { controller, directory, insert } = await setup({
      cleanup: async () => {
        throw new Error("Worker exited");
      },
    });
    await controller.execute({
      type: "dictionary",
      lists: [
        {
          id: "personal",
          name: "Personal",
          terms: [{ id: "pathway", spelling: "Pathway", aliases: ["path way"] }],
        },
      ],
      connected: true,
    });
    await controller.start("hold");
    await controller.stop();
    expect(insert).toHaveBeenCalledWith("Hello from Pathway.");
    const [entry] = await controller.listHistory();
    expect(entry).toMatchObject({
      originalText: "Hello from path way.",
      text: "Hello from Pathway.",
      cleanup: "unavailable",
    });
    expect(controller.getState().error).toContain("Cleanup unavailable");
    expect(await NodeFSP.readdir(NodePath.join(directory, "temporary"))).toEqual([]);
  });

  it("delivers a valid cleanup that removes a past-tense spoken correction cue", async () => {
    const originalText =
      "Prepare six boxes. Sorry, I meant eight boxes. Then label the remaining boxes.";
    const text = "Prepare eight boxes. Then label the remaining boxes.";
    const { controller, insert } = await setup({
      transcribe: async () => originalText,
      cleanup: async () => text,
    });
    await controller.start("hold");
    await controller.stop();
    expect(insert).toHaveBeenCalledWith(text);
    expect(controller.getState()).toMatchObject({
      phase: "result",
      error: null,
      result: { originalText, text, cleanup: "applied" },
    });
    expect(await controller.listHistory()).toMatchObject([
      { originalText, text, cleanup: "applied" },
    ]);
  });

  it("keeps the transcript without retrying when native insertion fails", async () => {
    const { controller, insert, directory } = await setup();
    insert.mockRejectedValueOnce(new Error("Native host disconnected during insertion"));
    await controller.start("hold");
    await controller.stop();
    expect(insert).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({
      phase: "result",
      result: { text: "Hello from Pathway.", delivery: "unconfirmed" },
    });
    expect(await controller.listHistory()).toMatchObject([
      {
        originalText: "Hello from path way.",
        text: "Hello from Pathway.",
        delivery: "unconfirmed",
      },
    ]);
    expect(await NodeFSP.readdir(NodePath.join(directory, "temporary"))).toEqual([]);
  });

  it("reviews microphone interruption without inserting and ignores stale capture events", async () => {
    const { controller, captureId, insert } = await setup();
    await controller.start("locked");
    await controller.microphoneDisconnected("old-capture", 1000);
    expect(controller.getState().phase).toBe("recording");
    await controller.microphoneDisconnected(captureId(), 1500);
    expect(insert).not.toHaveBeenCalled();
    expect(controller.getState().result).toMatchObject({ delivery: "manual", durationMs: 1500 });
  });

  it("does not allow dismissal to reset an active recording", async () => {
    const { controller } = await setup();
    await controller.start("locked");
    await controller.execute({ type: "dismiss" });
    expect(controller.getState().phase).toBe("recording");
    await controller.cancel();
    expect(controller.getState().phase).toBe("idle");
  });

  it("microphone tests do not insert text or create history", async () => {
    const { controller, insert } = await setup();
    await controller.start("test");
    await controller.stop();
    expect(insert).not.toHaveBeenCalled();
    expect(controller.getState().result?.delivery).toBe("test");
    expect(await controller.listHistory()).toEqual([]);
    await controller.execute({ type: "dismiss" });
    expect(controller.getState()).toMatchObject({ phase: "idle", mode: "hold", result: null });
  });
});

describe("dictation setup permissions", () => {
  it.each(["microphone", "accessibility"] as const)(
    "requests only the selected %s permission",
    async (action) => {
      const permissions = vi.fn<DictationNativePort["permissions"]>(async () => ({
        microphone: "granted",
        accessibility: "granted",
      }));
      const configure = vi.fn<DictationNativePort["configure"]>(async () => {});
      const { controller } = await setup({}, { enable: false, native: { permissions, configure } });
      await controller.execute({ type: "permissions", action });
      expect(permissions.mock.calls).toEqual([[true, action]]);
      expect(configure.mock.calls).toEqual([["fn", false]]);
      expect(controller.getState()).toMatchObject({
        microphonePermission: "granted",
        accessibilityPermission: "granted",
        preferences: { enabled: false, setupComplete: false },
      });
    },
  );

  it("refreshes permission and microphone status without requesting a grant", async () => {
    const permissions = vi.fn<DictationNativePort["permissions"]>(async () => ({
      microphone: "unknown",
      accessibility: "denied",
    }));
    const microphones = vi.fn<DictationNativePort["microphones"]>(async () => [
      { id: "desk", name: "Desk microphone", isDefault: true },
    ]);
    const { controller } = await setup({}, { enable: false, native: { permissions, microphones } });
    await controller.execute({ type: "permissions", action: "refresh" });
    await controller.execute({ type: "refresh-devices" });
    expect(permissions.mock.calls).toEqual([
      [false, undefined],
      [false, undefined],
    ]);
    expect(controller.getState()).toMatchObject({
      microphonePermission: "unknown",
      accessibilityPermission: "denied",
      microphones: [{ id: "desk", name: "Desk microphone", isDefault: true }],
      preferences: { enabled: false },
    });
  });

  it.each([
    { microphone: "denied", accessibility: "granted" },
    { microphone: "granted", accessibility: "denied" },
    { microphone: "unknown", accessibility: "granted" },
  ] as const)("does not persist enabled setup without grants: %j", async (grants) => {
    const permissions = vi.fn<DictationNativePort["permissions"]>(async () => grants);
    const configure = vi.fn<DictationNativePort["configure"]>(async () => {});
    const { controller, storage } = await setup(
      {},
      { enable: false, native: { permissions, configure } },
    );
    await expect(
      controller.execute({
        type: "preferences",
        preferences: { ...controller.getState().preferences, setupComplete: true, enabled: true },
      }),
    ).rejects.toThrow("Allow microphone and Accessibility access");
    expect(permissions.mock.calls).toEqual([[false, undefined]]);
    expect(configure.mock.calls).toEqual([["fn", false]]);
    expect(controller.getState()).toMatchObject({
      phase: "disabled",
      preferences: { enabled: false, setupComplete: false },
    });
    expect(await storage.preferences("darwin")).toMatchObject({
      enabled: false,
      setupComplete: false,
    });
  });

  it("discards a permission response belonging to the previous account", async () => {
    const requested = deferred<void>();
    const response = deferred<Awaited<ReturnType<DictationNativePort["permissions"]>>>();
    const permissions = vi.fn<DictationNativePort["permissions"]>(() => {
      requested.resolve();
      return response.promise;
    });
    const microphones = vi.fn<DictationNativePort["microphones"]>(async () => []);
    const configure = vi.fn<DictationNativePort["configure"]>(async () => {});
    const { controller } = await setup(
      {},
      { enable: false, native: { permissions, microphones, configure } },
    );
    const checking = controller.execute({ type: "permissions", action: "microphone" });
    await requested.promise;
    await controller.execute({ type: "account", accountId: "second-account" });
    response.resolve({ microphone: "granted", accessibility: "granted" });
    await checking;
    expect(microphones).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({
      accountId: "second-account",
      authenticated: true,
      microphonePermission: "unknown",
      accessibilityPermission: "unknown",
      phase: "disabled",
    });
  });

  it("does not enable dictation after sign-out during the grant recheck", async () => {
    const requested = deferred<void>();
    const response = deferred<Awaited<ReturnType<DictationNativePort["permissions"]>>>();
    const permissions = vi.fn<DictationNativePort["permissions"]>(() => {
      requested.resolve();
      return response.promise;
    });
    const configure = vi.fn<DictationNativePort["configure"]>(async () => {});
    const { controller, storage } = await setup(
      {},
      { enable: false, native: { permissions, configure } },
    );
    const enabling = controller.execute({
      type: "preferences",
      preferences: { ...controller.getState().preferences, enabled: true, setupComplete: true },
    });
    const rejected = expect(enabling).rejects.toThrow("Sign in to Pathway to enable dictation");
    await requested.promise;
    await controller.execute({ type: "account", accountId: null });
    response.resolve({ microphone: "granted", accessibility: "granted" });
    await rejected;
    expect(configure).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({
      authenticated: false,
      phase: "disabled",
      preferences: { enabled: false },
    });
    expect(await storage.preferences("darwin")).toMatchObject({
      enabled: false,
      setupComplete: false,
    });
  });
});
