// @effect-diagnostics nodeBuiltinImport:off -- Mock child process boundary; no simulator or real process is started.
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import { expect, it, vi, afterEach } from "vite-plus/test";
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
import { runSimBuildProcess } from "./SimBuildProcess.ts";

function child() {
  const signalGroup = vi.spyOn(process, "kill").mockReturnValue(true);
  const handle = Object.assign(new NodeEvents.EventEmitter(), {
    stdout: new NodeStream.PassThrough(),
    stderr: new NodeStream.PassThrough(),
    kill: vi.fn(),
    pid: 43210,
  });
  spawn.mockReturnValue(handle);
  return {
    handle,
    signalGroup,
    close: (code: number | null) => {
      handle.stdout.end();
      handle.stderr.end();
      handle.emit("exit", code);
      handle.emit("close", code);
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  spawn.mockReset();
  vi.restoreAllMocks();
});

it("passes argv without a shell and streams both pipes without collecting build output", async () => {
  const c = child();
  const output = vi.fn(async () => undefined);
  const result = runSimBuildProcess(
    {
      file: "/xcodebuild",
      args: ["-scheme", "App with spaces"],
      env: { DEVELOPER_DIR: "/chosen" },
    },
    new AbortController().signal,
    output,
  );
  c.handle.stdout.write("building\n");
  c.handle.stderr.write("warning: warning\n");
  c.close(0);
  expect(await result).toBe("");
  expect(output).toHaveBeenCalledWith("building\n", "stdout");
  expect(output).toHaveBeenCalledWith("warning: warning\n", "stderr");
  expect(spawn.mock.calls[0]?.slice(0, 2)).toEqual(["/xcodebuild", ["-scheme", "App with spaces"]]);
  expect(spawn.mock.calls[0]?.[2].shell).toBeUndefined();
  expect(spawn.mock.calls[0]?.[2].detached).toBe(true);
});
it("signals only the spawned process group and drains after escalation", async () => {
  vi.useFakeTimers();
  const c = child();
  const controller = new AbortController();
  const result = runSimBuildProcess({ file: "xcodebuild", args: [] }, controller.signal);
  const rejected = expect(result).rejects.toMatchObject({ code: "cancelled" });
  controller.abort();
  expect(c.signalGroup).toHaveBeenCalledExactlyOnceWith(-43210, "SIGTERM");
  await vi.advanceTimersByTimeAsync(5000);
  expect(c.signalGroup).toHaveBeenLastCalledWith(-43210, "SIGKILL");
  expect(c.handle.stdout.destroyed).toBe(true);
  expect(c.handle.stderr.destroyed).toBe(true);
  expect(c.handle.kill).not.toHaveBeenCalled();
  c.close(null);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});
it("never spawns after cancellation and reports nonzero exits", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    runSimBuildProcess({ file: "xcodebuild", args: [] }, controller.signal),
  ).rejects.toBeDefined();
  expect(spawn).not.toHaveBeenCalled();
  const c = child();
  const result = runSimBuildProcess({ file: "xcodebuild", args: [] }, new AbortController().signal);
  c.close(65);
  await expect(result).rejects.toMatchObject({
    code: "process-failed",
    message: expect.stringContaining("65"),
  });
});
it("awaits the output consumer and bounds JSON capture", async () => {
  const c = child();
  let resume!: () => void;
  const drained = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let seen!: () => void;
  const consumed = new Promise<void>((resolve) => {
    seen = resolve;
  });
  const result = runSimBuildProcess(
    { file: "xcodebuild", args: [], capture: true },
    new AbortController().signal,
    async () => {
      seen();
      await drained;
    },
  );
  c.handle.stdout.write("json");
  await consumed;
  c.close(0);
  resume();
  expect(await result).toBe("json");
  const large = child();
  const overflow = runSimBuildProcess(
    { file: "xcodebuild", args: [], capture: true },
    new AbortController().signal,
  );
  const killed = new Promise<void>((resolve) => {
    large.signalGroup.mockImplementation(() => {
      resolve();
      return true;
    });
  });
  large.handle.stdout.write("x".repeat(8 * 1024 * 1024 + 1));
  await killed;
  large.close(0);
  await expect(overflow).rejects.toMatchObject({ code: "process-failed" });
});

it("terminates descendants after the leader exits without waiting for inherited pipe close", async () => {
  const c = child();
  const controller = new AbortController();
  const execution = runSimBuildProcess({ file: "xcodebuild", args: [] }, controller.signal);
  const rejected = expect(execution).rejects.toMatchObject({ code: "cancelled" });
  c.handle.emit("exit", 0);
  expect(c.handle.stdout.destroyed).toBe(false);
  controller.abort();
  await rejected;
  expect(c.signalGroup.mock.calls).toEqual([
    [-43210, "SIGTERM"],
    [-43210, "SIGKILL"],
  ]);
  expect(c.handle.stdout.destroyed).toBe(true);
  expect(c.handle.stderr.destroyed).toBe(true);
});
