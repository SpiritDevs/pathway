// @effect-diagnostics nodeBuiltinImport:off -- Native dictation runs in an isolated OS helper.
// @effect-diagnostics globalTimers:off -- Bounds child process startup and protocol requests.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

export type NativeDictationShortcut = "fn" | "right-control" | "right-option" | "F8";
export type NativeDictationPermission = "unknown" | "granted" | "denied";
export interface NativeDictationPermissions {
  microphone: NativeDictationPermission;
  accessibility: NativeDictationPermission;
  inputMonitoring: NativeDictationPermission;
}
export interface NativeDictationMicrophone {
  id: string;
  name: string;
  isDefault: boolean;
}
export interface NativeDictationCapture {
  id: string;
  path: string;
  durationMs: number;
}
export interface NativeDictationInsertion {
  status: "inserted" | "manual" | "unconfirmed";
  reason?: string;
}
export type NativeDictationCommand =
  | { type: "enumerate" }
  | { type: "permissions"; request?: boolean; permission?: "microphone" | "accessibility" }
  | { type: "startCapture"; id: string; path: string; deviceId?: string }
  | { type: "stopCapture"; id?: string }
  | { type: "cancelCapture"; id?: string }
  | { type: "configureShortcut"; shortcut: NativeDictationShortcut; enabled: boolean }
  | { type: "insert"; text: string }
  | { type: "shutdown" };
export interface NativeDictationResults {
  enumerate: NativeDictationMicrophone[];
  permissions: NativeDictationPermissions;
  startCapture: { id: string };
  stopCapture: NativeDictationCapture;
  cancelCapture: { cancelled: boolean };
  configureShortcut: { enabled: boolean; shortcut: NativeDictationShortcut };
  insert: NativeDictationInsertion;
  shutdown: { shutdown: true };
}
export type NativeDictationEvent =
  | {
      type: "ready";
      protocolVersion: 1;
      platform: "darwin" | "win32";
      shortcuts: NativeDictationShortcut[];
    }
  | {
      type: "shortcut-down" | "shortcut-up";
      shortcut: NativeDictationShortcut;
      timestampMs: number;
    }
  | { type: "cancel"; reason: "escape" | "sleep" | "screen-lock" | "shortcut-interrupted" }
  | { type: "level"; id: string; durationMs: number; level: number }
  | ({ type: "capture-stopped" } & NativeDictationCapture)
  | ({ type: "microphone-disconnected"; reason: string } & NativeDictationCapture)
  | { type: "error"; message: string };

type Pending = {
  type: NativeDictationCommand["type"];
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type HostProcess = {
  child: NodeChildProcess.ChildProcessWithoutNullStreams;
  pending: Map<number, Pending>;
  started: Promise<void>;
  exited: Promise<void>;
  rejectStart: (error: Error) => void;
  ready: boolean;
  closing: boolean;
  finished: boolean;
};

/** JSON-lines helper. Requests use requestId, leaving id available for capture identity.
 * A failed or timed-out insert is unconfirmed and must never be retried automatically.
 * Await close on account changes, disable, and application quit.
 */
export class NativeDictationHost {
  private current: HostProcess | undefined;
  private closing: Promise<void> | undefined;
  private nextRequestId = 0;
  private readonly options: { binaryPath: string; onEvent: (event: NativeDictationEvent) => void };

  constructor(options: { binaryPath: string; onEvent: (event: NativeDictationEvent) => void }) {
    this.options = options;
  }

  start(): Promise<void> {
    if (this.closing) return this.closing.then(() => this.start());
    if (this.current) return this.current.started;
    let child: NodeChildProcess.ChildProcessWithoutNullStreams;
    try {
      // A direct, attached child preserves macOS responsibility inherited from the app.
      // An upstream script/CLI launcher must be fixed at the app boundary, not by changing helper identity.
      child = NodeChildProcess.spawn(this.options.binaryPath, [], {
        stdio: "pipe",
        windowsHide: true,
        shell: false,
        detached: false,
      });
    } catch (error) {
      return Promise.reject(error);
    }
    const started = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<void>();
    const instance: HostProcess = {
      child,
      pending: new Map(),
      started: started.promise,
      exited: exited.promise,
      rejectStart: started.reject,
      ready: false,
      closing: false,
      finished: false,
    };
    this.current = instance;
    let stderr = "";
    const startupTimer = setTimeout(() => {
      started.reject(new Error("Native dictation host did not become ready"));
      if (this.current === instance) void this.close();
      child.kill();
    }, 10_000);
    startupTimer.unref();
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4_096);
    });
    child.stdin.on("error", () => {
      /* Write callbacks and process exit settle requests. */
    });
    const lines = NodeReadline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (instance.finished || this.current !== instance) return;
      let message: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
        message = parsed as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof message.requestId === "number") {
        const pending = instance.pending.get(message.requestId);
        if (!pending) return;
        instance.pending.delete(message.requestId);
        clearTimeout(pending.timer);
        if (message.ok === true) pending.resolve(message.result);
        else {
          const reason =
            typeof message.error === "string" ? message.error : "Native dictation request failed";
          if (pending.type === "insert") pending.resolve({ status: "unconfirmed", reason });
          else pending.reject(new Error(reason));
        }
        return;
      }
      // A closing host can finish requests, but cannot reactivate an old account's recording UI.
      if (instance.closing) return;
      if (message.type === "ready") {
        if (message.protocolVersion !== 1) {
          started.reject(new Error("Unsupported native dictation protocol"));
          void this.close();
          child.kill();
          return;
        }
        instance.ready = true;
        clearTimeout(startupTimer);
        started.resolve();
      }
      if (typeof message.type === "string")
        this.options.onEvent(message as unknown as NativeDictationEvent);
    });
    const finish = (error: Error, unexpected: boolean) => {
      if (instance.finished) return;
      instance.finished = true;
      clearTimeout(startupTimer);
      lines.close();
      const wasCurrent = this.current === instance;
      if (wasCurrent) this.current = undefined;
      started.reject(error);
      for (const pending of instance.pending.values()) {
        clearTimeout(pending.timer);
        if (pending.type === "insert")
          pending.resolve({ status: "unconfirmed", reason: error.message });
        else pending.reject(error);
      }
      instance.pending.clear();
      exited.resolve();
      if (wasCurrent && instance.ready && !instance.closing && unexpected)
        this.options.onEvent({ type: "error", message: error.message });
    };
    child.once("error", (error) => {
      if (instance.finished) return;
      if (child.pid === undefined)
        finish(error, false); // Spawn failed; there is no OS process to await.
      else {
        started.reject(error);
        if (this.current === instance) void this.close();
      }
    });
    // close follows process exit and drainage of stdout, so its last response is not lost.
    child.once("close", (code, signal) => {
      finish(
        new Error(
          `Native dictation host exited (${signal ?? code})${stderr ? `: ${stderr.trim()}` : ""}`,
        ),
        code !== 0,
      );
    });
    return started.promise;
  }

  async request<C extends NativeDictationCommand>(
    command: C,
  ): Promise<NativeDictationResults[C["type"]]> {
    await this.start();
    // close may have begun while the resolved startup promise was yielding to its caller.
    if (this.closing) return this.request(command);
    const instance = this.current;
    if (!instance || !instance.ready) throw new Error("Native dictation host is unavailable");
    const requestId = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          instance.pending.delete(requestId);
          if (command.type === "insert") {
            resolve({
              status: "unconfirmed",
              reason: "The application did not confirm insertion",
            } as NativeDictationResults[C["type"]]);
          } else {
            reject(new Error(`Native dictation ${command.type} timed out`));
            if (
              this.current === instance &&
              (command.type === "startCapture" ||
                command.type === "stopCapture" ||
                command.type === "cancelCapture")
            )
              void this.close();
          }
        },
        command.type === "permissions" && command.request ? 120_000 : 15_000,
      );
      timer.unref();
      instance.pending.set(requestId, {
        type: command.type,
        resolve: (value) => resolve(value as NativeDictationResults[C["type"]]),
        reject,
        timer,
      });
      const writeFailed = (error: Error | null | undefined) => {
        if (!error) return;
        const pending = instance.pending.get(requestId);
        if (!pending) return;
        clearTimeout(timer);
        instance.pending.delete(requestId);
        if (command.type === "insert")
          pending.resolve({ status: "unconfirmed", reason: error.message });
        else reject(error);
      };
      try {
        instance.child.stdin.write(`${JSON.stringify({ ...command, requestId })}\n`, writeFailed);
      } catch (error) {
        writeFailed(error instanceof Error ? error : new Error("Native dictation write failed"));
      }
      if (command.type === "shutdown") void this.close();
    });
  }

  /** EOF requests native cleanup. Resolves after exit and stdout drainage; later starts wait here. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const instance = this.current;
    if (!instance) return Promise.resolve();
    instance.closing = true;
    instance.ready = false;
    instance.rejectStart(new Error("Native dictation host closed during startup"));
    const timer = setTimeout(() => instance.child.kill("SIGKILL"), 5_000);
    timer.unref();
    const closing = instance.exited.then(() => {
      clearTimeout(timer);
      if (this.closing === closing) this.closing = undefined;
    });
    this.closing = closing;
    instance.child.stdin.end();
    return closing;
  }
}
