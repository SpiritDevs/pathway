// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Captured-child process boundary; no shell, process groups, or PID discovery.
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

/** Pipe consumers await the bounded log sink. Abort waits for this child to close before releasing the job lock. */
export const runSimBuildProcess: SimBuildProcess = async (command, signal, output) => {
  signal.throwIfAborted();
  const child = NodeChildProcess.spawn(command.file, [...command.args], {
    cwd: command.cwd,
    env: { ...process.env, ...command.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const abort = () => {
    if (closed) return;
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => {
      if (!closed) child.kill("SIGKILL");
    }, 5_000);
  };
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      closed = true;
      resolve(code);
    });
  });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let captured = "";
  let consumerFailure: unknown;
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
