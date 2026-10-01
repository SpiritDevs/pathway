// @effect-diagnostics nodeBuiltinImport:off -- Real, owned subprocess fixture; no Xcode or simulator is started.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import { expect, it, onTestFinished, vi } from "vite-plus/test";

const { spawned } = vi.hoisted(() => ({
  spawned: vi.fn<(child: NodeChildProcess.ChildProcess) => void>(),
}));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof NodeChildProcess>("node:child_process");
  return {
    ...actual,
    spawn: (file: string, args: string[], options: NodeChildProcess.SpawnOptions) => {
      // This receipt pipe is outside the adapter's stdout/stderr ownership. EOF
      // proves the descendant exited, even when the adapter destroys its pipes.
      const child = actual.spawn(file, args, {
        ...options,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      });
      spawned(child);
      return child;
    },
  };
});
import { runSimBuildProcess } from "./SimBuildProcess.ts";

it("cancels a real descendant that ignores SIGTERM and holds the exited leader's pipes", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sim-build-process-tree-"));
  const controller = new AbortController();
  const descendant = `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    fs.watch(${JSON.stringify(root)}, () => {});
    fs.writeSync(3, 'descendant-ready');
  `;
  const parent = `
    const { spawn } = require('node:child_process');
    process.on('SIGTERM', () => process.exit(0));
    spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
      stdio: ['ignore', 'inherit', 'inherit', 3]
    });
  `;
  const execution = runSimBuildProcess(
    { file: process.execPath, args: ["-e", parent] },
    controller.signal,
  );
  const cancelled = expect(execution).rejects.toMatchObject({ code: "cancelled" });
  const child = spawned.mock.calls[0]![0];
  let closed = false;
  const drained = new Promise<void>((resolve) => {
    child.once("close", () => {
      closed = true;
      resolve();
    });
  });
  onTestFinished(async () => {
    controller.abort();
    if (!closed && child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    await drained;
    await NodeFSP.rm(root, { recursive: true, force: true });
  });
  const pipe = child.stdio[3];
  if (!(pipe instanceof NodeStream.Readable)) throw new Error("Missing descendant receipt pipe.");
  const descendantExited = new Promise<void>((resolve) => pipe.once("end", resolve));
  const receipt = await new Promise<unknown>((resolve, reject) => {
    pipe.once("data", resolve);
    pipe.once("error", reject);
  });
  expect(String(receipt)).toBe("descendant-ready");
  pipe.resume();
  controller.abort();
  await Promise.all([cancelled, descendantExited, drained]);
  expect(child.exitCode).toBe(0);
  expect(child.stdout?.destroyed).toBe(true);
  expect(child.stderr?.destroyed).toBe(true);
});
