// @effect-diagnostics globalTimers:off nodeBuiltinImport:off -- Child lifetime boundary. Timers bound a captured child, never discover PIDs.
import * as NodeChildProcess from "node:child_process";
import { xcodeError } from "./XcodeInstall.ts";
export type XcodeCommand = {
  file: string;
  args: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
  timeoutMs?: number;
};
export type XcodeProcessRunner = (command: XcodeCommand, signal: AbortSignal) => Promise<string>;
/** No shell and no raw stderr in RPC errors. Every signal targets this invocation's captured child. */
export const runXcodeProcess: XcodeProcessRunner = (command, signal) =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = NodeChildProcess.spawn(command.file, [...command.args], {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let failed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      failed = true;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    const timer = setTimeout(abort, command.timeoutMs ?? 120_000);
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (data: Buffer) => {
      if (output.length + data.length > 8 * 1024 * 1024) abort();
      else output += data.toString();
    });
    child.stderr.resume();
    child.on("error", () => {
      cleanup();
      reject(xcodeError("process-failed", "Could not start an Xcode host tool."));
    });
    child.on("close", (code) => {
      cleanup();
      if (code === 0 && !failed && !signal.aborted) resolve(output);
      else
        reject(
          xcodeError(
            signal.aborted ? "cancelled" : "process-failed",
            signal.aborted
              ? "The Xcode operation was cancelled."
              : "An Xcode host tool failed or timed out.",
          ),
        );
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(command.input);
    if (signal.aborted) abort();
  });
