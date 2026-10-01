// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Each invocation owns a detached POSIX process group, captured at spawn.
import * as Schema from "effect/Schema";
import * as NodeChildProcess from "node:child_process";
import { SimBuildError } from "@spiritdevs/contracts/simBuild";

const isBuildError = Schema.is(SimBuildError);

export interface SimBuildCommand {
  file: string;
  args: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  capture?: boolean;
}
export type SimBuildOutput = (text: string, source: "stdout" | "stderr") => Promise<void>;
export type SimBuildProcess = (
  command: SimBuildCommand,
  signal: AbortSignal,
  output?: SimBuildOutput,
) => Promise<string>;

/** Mac-only host adapter. Cancellation drains the owned group and pipes, even after its leader exits. */
export const runSimBuildProcess: SimBuildProcess = async (command, signal, output) => {
  signal.throwIfAborted();
  const child = NodeChildProcess.spawn(command.file, [...command.args], {
    cwd: command.cwd,
    env: { ...process.env, ...command.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const groupId = child.pid;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let exited = false;
  let stopping = false;
  let stopped = false;
  let consumerFailure: unknown;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (groupId === undefined) return;
    try {
      process.kill(-groupId, signal);
    } catch (error) {
      // The group may have exited between delivery and the leader's exit event.
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
        consumerFailure = error;
    }
  };
  const finishStop = () => {
    if (stopped) return;
    stopped = true;
    if (killTimer) clearTimeout(killTimer);
    killTimer = undefined;
    signalGroup("SIGKILL");
    // Descendants can inherit these pipes beyond the leader's exit. Do not let
    // a held fd prevent cancellation from draining the parent's consumers.
    child.stdout.destroy();
    child.stderr.destroy();
  };
  const abort = () => {
    if (stopping) return;
    stopping = true;
    signalGroup("SIGTERM");
    if (exited) finishStop();
    else killTimer = setTimeout(finishStop, 5_000);
  };
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      exited = true;
      if (stopping) finishStop();
      resolve(code);
    });
  });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let captured = "";
  const consume = async (source: "stdout" | "stderr") => {
    const stream = child[source];
    stream.setEncoding("utf8");
    try {
      for await (const chunk of stream) {
        const text = String(chunk);
        if (command.capture && source === "stdout") {
          if (captured.length + text.length > 8 * 1024 * 1024)
            throw new Error("Tool response exceeded 8 MiB.");
          captured += text;
        }
        if (output) await output(text, source);
      }
    } catch (error) {
      consumerFailure = error;
      abort();
    }
  };
  try {
    const [code] = await Promise.all([completion, consume("stdout"), consume("stderr")]);
    if (signal.aborted)
      throw new SimBuildError({ code: "cancelled", message: "Simulator build cancelled." });
    if (consumerFailure || code !== 0)
      throw new SimBuildError({
        code: "process-failed",
        message: `${command.file.split("/").at(-1)} failed${code === null ? "" : ` with exit code ${code}`}. See the build log.`,
      });
    return captured;
  } catch (error) {
    if (isBuildError(error)) throw error;
    throw new SimBuildError({
      code: "process-failed",
      message: "Could not run the simulator build tool.",
    });
  } finally {
    signal.removeEventListener("abort", abort);
    if (killTimer) clearTimeout(killTimer);
  }
};
