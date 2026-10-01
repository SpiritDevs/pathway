// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Bounded process-output batching boundary.
import * as NodePath from "node:path";
import {
  SIM_BUILD_LOG_CHUNK_CHARS,
  SIM_BUILD_LOG_WINDOW_CHARS,
  type SimBuildDiagnostic,
  type SimBuildLogChunk,
} from "@spiritdevs/contracts/simBuild";

export function parseSimBuildDiagnostic(line: string, cwd: string): SimBuildDiagnostic | null {
  // eslint-disable-next-line no-control-regex -- Strip ANSI color escapes emitted by build tools.
  const plain = line.replace(/\u001b\[[0-9;]*m/g, "");
  const located = /^(.*?):(\d+)(?::(\d+))?:\s*(warning|error):\s*(.*)$/.exec(plain);
  if (located)
    return {
      severity: located[4] as "warning" | "error",
      message: located[5]!,
      file: NodePath.resolve(cwd, located[1]!),
      line: Number(located[2]),
      column: located[3] ? Number(located[3]) : null,
    };
  const generic = /(?:^|\s)(warning|error):\s*(.*)$/.exec(plain);
  return generic
    ? {
        severity: generic[1] as "warning" | "error",
        message: generic[2]!,
        file: null,
        line: null,
        column: null,
      }
    : null;
}

/** Keeps 64 Ki characters per job. The transport carries sequence gaps explicitly. */
export class SimBuildLog {
  readonly chunks: SimBuildLogChunk[] = [];
  nextSequence = 1;
  #pending = "";
  #lines = { stdout: "", stderr: "" };
  #diagnostics: SimBuildDiagnostic[] = [];
  #size = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly cwd: string;
  readonly notify: () => void;
  constructor(cwd: string, notify: () => void) {
    this.cwd = cwd;
    this.notify = notify;
  }
  async write(text: string, source: "stdout" | "stderr") {
    // Work a bounded slice at a time even when a mocked or native pipe returns a large buffer.
    for (let offset = 0; offset < text.length; ) {
      const piece = text.slice(offset, offset + SIM_BUILD_LOG_CHUNK_CHARS - this.#pending.length);
      offset += piece.length;
      this.#pending += piece;
      const lines = (this.#lines[source] + piece).split(/\r?\n/);
      this.#lines[source] = lines.pop()!.slice(-SIM_BUILD_LOG_CHUNK_CHARS);
      for (const line of lines) this.#parse(line);
      if (this.#pending.length === SIM_BUILD_LOG_CHUNK_CHARS) this.flush();
    }
    if (this.#pending && !this.#timer) this.#timer = setTimeout(() => this.flush(), 100);
  }
  #parse(line: string) {
    const diagnostic = parseSimBuildDiagnostic(line, this.cwd);
    if (diagnostic && this.#diagnostics.length < 128) this.#diagnostics.push(diagnostic);
  }
  flush(final = false) {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (final)
      for (const source of ["stdout", "stderr"] as const) {
        this.#parse(this.#lines[source]);
        this.#lines[source] = "";
      }
    if (!this.#pending && this.#diagnostics.length === 0) return;
    const chunk = {
      sequence: this.nextSequence++,
      text: this.#pending,
      diagnostics: this.#diagnostics,
    };
    this.#pending = "";
    this.#diagnostics = [];
    this.chunks.push(chunk);
    this.#size += chunk.text.length;
    while (this.#size > SIM_BUILD_LOG_WINDOW_CHARS || this.chunks.length > 64)
      this.#size -= this.chunks.shift()!.text.length;
    this.notify();
  }
}
