import { describe, expect, it, vi } from "vite-plus/test";

const { forkedWorkers } = vi.hoisted(() => ({
  forkedWorkers: [] as Array<{
    kill: ReturnType<typeof vi.fn>;
    emitMessage: (message: string) => void;
    emitExit: (code: number) => void;
  }>,
}));

vi.mock("node:child_process", () => ({
  fork: () => {
    const listeners = new Map<string, Array<(value?: unknown) => void>>();
    const record = {
      kill: vi.fn(() => true),
      emitMessage: (message: string) => {
        for (const listener of listeners.get("message") ?? []) listener(message);
      },
      emitExit: (code: number) => {
        for (const listener of listeners.get("exit") ?? []) listener(code);
      },
    };
    forkedWorkers.push(record);
    return {
      on: (event: string, listener: (value?: unknown) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
      once: (event: string, listener: (value?: unknown) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
      kill: record.kill,
    };
  },
}));

import { startGlobalShiftShortcutProcess } from "./GlobalShiftShortcutProcess.ts";

describe("global modifier shortcut worker", () => {
  it("kills and rejects a worker that never becomes ready", async () => {
    vi.useFakeTimers();
    try {
      forkedWorkers.length = 0;
      const onFailure = vi.fn();
      const started = startGlobalShiftShortcutProcess(
        "/worker.cjs",
        "shift",
        () => undefined,
        onFailure,
      );
      const failure = expect(started).rejects.toThrow(/timed out while starting/);
      const worker = forkedWorkers[0]!;

      await vi.advanceTimersByTimeAsync(5_000);
      await failure;
      expect(worker.kill).toHaveBeenCalledOnce();

      worker.emitExit(1);
      expect(onFailure).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the startup deadline once the worker is ready", async () => {
    vi.useFakeTimers();
    try {
      forkedWorkers.length = 0;
      const onFailure = vi.fn();
      const started = startGlobalShiftShortcutProcess(
        "/worker.cjs",
        "control",
        () => undefined,
        onFailure,
      );
      const worker = forkedWorkers[0]!;
      worker.emitMessage("ready");
      const stop = await started;

      await vi.advanceTimersByTimeAsync(5_000);
      expect(worker.kill).not.toHaveBeenCalled();
      expect(onFailure).not.toHaveBeenCalled();

      stop();
      worker.emitExit(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
