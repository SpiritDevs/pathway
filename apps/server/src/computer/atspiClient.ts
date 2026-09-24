/**
 * Supervises `atspi_helper.py`, the small PyGObject AT-SPI reader behind the
 * KWin engine's accessibility trees. It speaks newline-delimited JSON-RPC over
 * stdio and answers one request at a time.
 *
 * The helper keeps only caches it can rebuild: a crashed process loses one
 * perception request, and the next request starts a fresh one after a bounded
 * backoff. A helper that cannot run here at all (no interpreter, no bindings,
 * no accessibility bus) latches unavailable for a growing retry window instead
 * of being respawned on every read.
 *
 * Build one with `makeAtspiHelperClient` in the backend's scope; closing that
 * scope stops the helper.
 *
 * @module computer/atspiClient
 */
import type { ComputerRect, ComputerWindow } from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { asarUnpackedPath } from "../platform/asarUnpackedPath.ts";
import type { AtspiClientSize, AtspiWindowTree } from "./atspiTreeTargeting.ts";
import type { ComputerOperationError } from "./computerErrors.ts";
import {
  assertDesktopOperationActive,
  checkDesktopSignal,
  desktopOperationSignal,
} from "./DesktopOperationQueue.ts";

const HELPER_READ_TREE_METHOD = "read-tree";
const HELPER_SET_TEXT_METHOD = "set-text";
const HELPER_VALIDATE_NODE_METHOD = "validate-node";
const HELPER_PROBE_METHOD = "probe";
/**
 * The wire contract `atspi_helper.py` speaks (its `PROTOCOL_VERSION`). Every
 * request carries it and every reply names it, so a helper from another build
 * — a stale file, a `PATHWAY_ATSPI_HELPER` override — is refused as unavailable
 * instead of having its trees misread.
 */
export const ATSPI_HELPER_PROTOCOL = 2;
/** The helper could not reach the accessibility bus (it answers; it does not crash). */
const HELPER_BUS_UNAVAILABLE_ERROR = -32010;
/** The helper refused this client's protocol version. */
const HELPER_PROTOCOL_MISMATCH_ERROR = -32011;
const HELPER_MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** How much of the helper's stderr to keep for the diagnostic when it dies. */
const HELPER_STDERR_TAIL_CHARS = 4 * 1024;
const HELPER_REQUEST_TIMEOUT_MS = 10_000;
const HELPER_RECONNECT_BASE_DELAY_MS = 250;
const HELPER_RECONNECT_MAX_DELAY_MS = 5_000;
/** How long a SIGTERM'd helper has to exit before it is sent SIGKILL. */
const ATSPI_KILL_GRACE = Duration.seconds(1);
/** How long an exited helper's stderr may keep arriving before its diagnostic is cut. */
const HELPER_STDERR_DRAIN = Duration.seconds(1);
/**
 * How long "unavailable" holds before a request may look again, doubling up to
 * the cap. A machine that has no accessibility bus now may get one (a session
 * whose launcher starts late), but rediscovering its absence on every read is
 * what turned a crashing helper into a respawn storm.
 */
const UNAVAILABLE_RETRY_BASE_MS = 30_000;
const UNAVAILABLE_RETRY_MAX_MS = 5 * 60_000;
const REQUEST_QUEUE_LIMIT = 64;

/**
 * A semantic text write addressed the same way the tree was read: the window
 * descriptor the helper matched, plus the child-index path it emitted. The
 * helper re-resolves both on every call, so nothing depends on the process that
 * produced the tree still being alive.
 */
export interface AtspiTextWrite {
  readonly window: ComputerWindow;
  readonly path: readonly number[];
  readonly text: string;
  /** Checked against the live node so tree drift cannot redirect the write. */
  readonly role?: string;
  readonly label?: string | null;
}

/**
 * The helper cannot run on this machine at all: no `python3`, PyGObject
 * without the AT-SPI bindings, a helper that died before it ever answered.
 * Distinct from a transient failure so callers can stop retrying and show
 * the diagnostic instead.
 */
export class AtspiHelperUnavailableError extends Schema.TaggedErrorClass<AtspiHelperUnavailableError>()(
  "AtspiHelperUnavailableError",
  { message: Schema.String },
) {}

/**
 * A request that did not produce an answer: the helper refused it (`code` is
 * its JSON-RPC error code), timed out, died, or the client is closed.
 *
 * A refusal is the helper answering "no", as opposed to the helper being gone:
 * a window that closed while its tree was being walked, an unknown method on an
 * older helper build. Killing the process over one turns every routine
 * semantic-target miss into a respawn and ratchets the reconnect backoff to five
 * seconds, so the next few perception requests are slow for no reason.
 */
export class AtspiHelperRequestError extends Schema.TaggedErrorClass<AtspiHelperRequestError>()(
  "AtspiHelperRequestError",
  {
    message: Schema.String,
    code: Schema.optional(Schema.Number),
    /** The helper answered with an error envelope; the process is healthy. */
    refused: Schema.Boolean,
  },
) {}

export type AtspiHelperError =
  | AtspiHelperUnavailableError
  | AtspiHelperRequestError
  | ComputerOperationError;

/** A node a tree read addressed, checked against the live application at dispatch. */
export interface AtspiNodeCheck {
  readonly window: ComputerWindow;
  readonly path: readonly number[];
  readonly role: string;
  readonly label: string | null;
}

/**
 * The live node still is the one the tree named: its extents now, in the
 * window's coordinates, and the window's client size to place them with.
 */
export type AtspiNodeValidation =
  | {
      readonly ok: true;
      readonly frame: ComputerRect;
      readonly clientSize: AtspiClientSize;
      readonly showing: boolean | null;
    }
  | { readonly ok: false; readonly reason: string };

export interface AtspiReadOptions {
  /**
   * How old a tree the helper may answer from its event-validated cache. The
   * helper serves one only when the application has sent no event since the
   * walk; the caller bounds the age further by what it did itself, because
   * its own input is the change most likely to have arrived without one yet.
   */
  readonly maxAgeMs?: number;
}

export interface AtspiTreeReader {
  /**
   * Trees for the windows the helper could resolve. A window missing from the
   * result was not found, was ambiguous, or was cut off by the helper's own
   * deadline; the caller derives per-window completeness from which ids came
   * back and from each tree's own `status`.
   */
  readonly readTrees: (
    windows: readonly ComputerWindow[],
    options?: AtspiReadOptions,
  ) => Effect.Effect<readonly AtspiWindowTree[], AtspiHelperError>;
  /** Succeeds with `false` when the helper refused the write; fails when it failed. */
  readonly setText: (write: AtspiTextWrite) => Effect.Effect<boolean, AtspiHelperError>;
  /**
   * Re-reads one node a tree read named — identity by role and label, and
   * fresh extents — so an action can use a tree without walking it again.
   * Absent on readers that cannot address nodes.
   */
  readonly validateNode?: (
    check: AtspiNodeCheck,
  ) => Effect.Effect<AtspiNodeValidation, AtspiHelperError>;
  /**
   * Start the helper once and ask whether it can read trees. Succeeds either
   * way; `unavailableReason` carries the outcome. Running it again re-probes a
   * reader that latched unavailable, which is how a machine that gained
   * `python-gi` or an accessibility bus mid-session recovers on the next
   * connect.
   */
  readonly probe?: Effect.Effect<void>;
  /**
   * Why the reader latched unavailable, or `undefined` while it is usable,
   * unprobed, or due for another look.
   */
  readonly unavailableReason?: Effect.Effect<string | undefined>;
  /**
   * Stops the helper process without closing the reader: the next request
   * starts a fresh one. For a backend letting an idle desktop go.
   */
  readonly release?: Effect.Effect<void>;
}

export interface AtspiHelperClientOptions {
  readonly pythonPath?: string;
  readonly scriptPath?: string;
  readonly requestTimeoutMs?: number;
  /**
   * Environment overrides for the helper process. The accessibility bus is
   * reached through the session bus, so a nested session hands its own
   * `DBUS_SESSION_BUS_ADDRESS` here to keep perception inside that session.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * `false`: the helper gets exactly `env`, none of this server's own
   * environment underneath it. A nested session needs that: merged over the
   * server's environment, a host `AT_SPI_BUS_ADDRESS` would point the helper
   * at the human's accessibility bus, whatever session bus `env` names.
   */
  readonly inheritEnv?: boolean;
}

/** The helper process's environment; see `AtspiHelperClientOptions.inheritEnv`. */
export function atspiHelperEnvironment(
  options: Pick<AtspiHelperClientOptions, "env" | "inheritEnv">,
  serverEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...(options.inheritEnv === false ? {} : serverEnv),
    ...options.env,
    PYTHONUNBUFFERED: "1",
  };
}

type RequestPriority = "high" | "normal";

type Reply = Deferred.Deferred<unknown, AtspiHelperRequestError>;

/** One running helper. Everything it reports after it is replaced is ignored. */
interface HelperProcess {
  readonly scope: Scope.Closeable;
  readonly input: Queue.Queue<string, Cause.Done>;
  readonly stderr: StderrTail;
  pending: { readonly id: number; readonly reply: Reply } | undefined;
}

/**
 * Starts the client in the current scope. Closing the scope stops the helper
 * and fails every request still waiting for it.
 */
export const makeAtspiHelperClient = Effect.fn("makeAtspiHelperClient")(function* (
  options: AtspiHelperClientOptions = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  const client = new AtspiHelperClient(options, spawner, scope);
  yield* Scope.addFinalizer(scope, client.dispose);
  return client;
});

export class AtspiHelperClient implements AtspiTreeReader {
  private process: HelperProcess | undefined;
  private readonly requestTimeoutMs: number;
  private reconnectFailures = 0;
  private nextId = 1;
  private disposed = false;
  /**
   * The helper answers one request at a time, so requests wait here. Writes,
   * node checks and one-window reads go first: a semantic write or a scoped
   * read must not sit behind a desktop-wide walk it has nothing to do with.
   */
  private readonly lanes: Record<
    RequestPriority,
    Deferred.Deferred<void, AtspiHelperRequestError>[]
  > = { high: [], normal: [] };
  private holder: Deferred.Deferred<void, AtspiHelperRequestError> | undefined;
  private queuedRequests = 0;
  /** Set by the first well-formed reply from any helper process. */
  private answered = false;
  /** Set by the first tree a helper process delivered. */
  private treeAnswered = false;
  /**
   * A helper that cannot read trees here. Every read would otherwise pay a
   * spawn and up to five seconds of backoff to rediscover the same missing
   * interpreter or bus, with its traceback drained unread. Held until
   * `retryAt`, after which the next request probes again.
   */
  private unavailable: {
    readonly summary: string;
    readonly stderr: StderrTail;
    readonly retryAt: number;
  } | null = null;
  private unavailableLatches = 0;
  private probeRun: Deferred.Deferred<void> | undefined;

  private readonly options: AtspiHelperClientOptions;
  private readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /** Where stopped helpers finish exiting; the client's own scope. */
  private readonly scope: Scope.Scope;

  constructor(
    options: AtspiHelperClientOptions,
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    scope: Scope.Scope,
  ) {
    this.options = options;
    this.spawner = spawner;
    this.scope = scope;
    this.requestTimeoutMs = options.requestTimeoutMs ?? HELPER_REQUEST_TIMEOUT_MS;
  }

  readTrees(
    windows: readonly ComputerWindow[],
    options: AtspiReadOptions = {},
  ): Effect.Effect<readonly AtspiWindowTree[], AtspiHelperError> {
    if (windows.length === 0) return Effect.succeed([]);
    return this.request(
      HELPER_READ_TREE_METHOD,
      {
        protocol: ATSPI_HELPER_PROTOCOL,
        windows: windows.map(helperWindow),
        ...(options.maxAgeMs !== undefined && options.maxAgeMs > 0
          ? { maxAgeMs: Math.round(options.maxAgeMs) }
          : {}),
      },
      windows.length === 1 ? "high" : "normal",
    ).pipe(
      Effect.flatMap((result): Effect.Effect<unknown[], AtspiHelperError> => {
        if (!isRecord(result) || !Array.isArray(result.trees)) {
          return Effect.fail(requestError("AT-SPI helper returned no tree list."));
        }
        return Effect.as(this.assertProtocol(result), result.trees);
      }),
      Effect.map((trees) => {
        this.treeAnswered = true;
        this.unavailableLatches = 0;
        // A reply flagged `partial` is the helper stopping at its own deadline
        // with the trees it had: a well-formed answer from a healthy process.
        return trees.filter(isAtspiWindowTree);
      }),
    );
  }

  setText(write: AtspiTextWrite): Effect.Effect<boolean, AtspiHelperError> {
    return this.request(
      HELPER_SET_TEXT_METHOD,
      {
        protocol: ATSPI_HELPER_PROTOCOL,
        window: helperWindow(write.window),
        path: [...write.path],
        text: write.text,
        ...(write.role ? { role: write.role } : {}),
        ...(write.label !== undefined ? { label: write.label ?? "" } : {}),
      },
      "high",
    ).pipe(
      Effect.map((result) => isRecord(result) && result.ok === true),
      // No helper at all is a refusal, not a failure: the caller falls back
      // to keystrokes the same way it does for a control that is not editable.
      Effect.catchTag("AtspiHelperUnavailableError", () => Effect.succeed(false)),
    );
  }

  validateNode(check: AtspiNodeCheck): Effect.Effect<AtspiNodeValidation, AtspiHelperError> {
    return this.request(
      HELPER_VALIDATE_NODE_METHOD,
      {
        protocol: ATSPI_HELPER_PROTOCOL,
        window: helperWindow(check.window),
        path: [...check.path],
        role: check.role,
        label: check.label ?? "",
      },
      "high",
    ).pipe(
      Effect.map((result): AtspiNodeValidation => {
        if (!isRecord(result)) return { ok: false, reason: "no-reply" };
        if (result.ok === true && isRect(result.frame) && isClientSize(result.clientSize)) {
          return {
            ok: true,
            frame: result.frame as ComputerRect,
            clientSize: result.clientSize as AtspiClientSize,
            showing: typeof result.showing === "boolean" ? result.showing : null,
          };
        }
        return { ok: false, reason: typeof result.reason === "string" ? result.reason : "refused" };
      }),
      Effect.catchTag("AtspiHelperUnavailableError", () =>
        Effect.succeed<AtspiNodeValidation>({ ok: false, reason: "unavailable" }),
      ),
    );
  }

  /** Concurrent callers share one probe. */
  readonly probe: Effect.Effect<void> = Effect.suspend(() => {
    if (this.probeRun) return Deferred.await(this.probeRun);
    const run = Deferred.makeUnsafe<void>();
    this.probeRun = run;
    // An explicit probe is a fresh start: the latch, its retry window and the
    // backoff a dead helper left behind all go, and the outcome replaces them.
    this.unavailable = null;
    this.unavailableLatches = 0;
    this.reconnectFailures = 0;
    return this.request(HELPER_PROBE_METHOD, {}, "high").pipe(
      Effect.matchEffect({
        onSuccess: (result) => this.noteProbe(result),
        onFailure: (error) => this.noteProbeFailure(error),
      }),
      Effect.ensuring(
        Effect.sync(() => {
          this.probeRun = undefined;
          Deferred.doneUnsafe(run, Exit.void);
        }),
      ),
    );
  });

  readonly unavailableReason: Effect.Effect<string | undefined> = Effect.map(
    Clock.currentTimeMillis,
    (now) =>
      !this.unavailable || now >= this.unavailable.retryAt ? undefined : this.unavailableText(),
  );

  private unavailableText(): string {
    if (!this.unavailable) return "AT-SPI helper unavailable";
    const stderr = this.unavailable.stderr.text();
    return stderr ? `${this.unavailable.summary}\n${stderr}` : this.unavailable.summary;
  }

  private noteProbe(result: unknown): Effect.Effect<void> {
    if (!isRecord(result) || result.protocol !== ATSPI_HELPER_PROTOCOL) {
      return this.latchUnavailable(
        protocolMismatch(isRecord(result) ? result.protocol : undefined),
      );
    }
    if (result.atspi === false) {
      const reason = typeof result.reason === "string" ? result.reason : "unknown reason";
      return this.latchUnavailable(`AT-SPI is unavailable: ${reason}`);
    }
    // The retry window keeps growing until a tree actually arrives: a helper
    // that probes fine and then dies on every walk is still broken.
    return Effect.sync(() => {
      this.unavailable = null;
    });
  }

  private noteProbeFailure(error: AtspiHelperError): Effect.Effect<void> {
    // A latch set on the way here (a helper that died, a bus it could not
    // reach) already says more than the probe's own error does.
    if (this.unavailable) return Effect.void;
    return this.latchUnavailable(`AT-SPI helper probe failed: ${error.message}`);
  }

  private latchUnavailable(summary: string, stderr = new StderrTail()): Effect.Effect<void> {
    return Effect.map(Clock.currentTimeMillis, (now) => {
      const delay = Math.min(
        UNAVAILABLE_RETRY_MAX_MS,
        UNAVAILABLE_RETRY_BASE_MS * 2 ** this.unavailableLatches,
      );
      this.unavailableLatches += 1;
      this.unavailable = { summary, stderr, retryAt: now + delay };
    });
  }

  private assertProtocol(
    result: Record<string, unknown>,
  ): Effect.Effect<void, AtspiHelperUnavailableError> {
    if (result.protocol === ATSPI_HELPER_PROTOCOL) return Effect.void;
    return this.latchUnavailable(protocolMismatch(result.protocol)).pipe(
      Effect.andThen(Effect.suspend(() => Effect.fail(this.unavailableError()))),
    );
  }

  private unavailableError(): AtspiHelperUnavailableError {
    return new AtspiHelperUnavailableError({ message: this.unavailableText() });
  }

  readonly release: Effect.Effect<void> = Effect.suspend(() => {
    if (this.disposed || this.process === undefined) return Effect.void;
    // Detached first, like every stop of ours, so its exit is not read as a
    // crash; and it is not a failure, so the next start carries no backoff.
    const reset = this.resetProcess("AT-SPI helper released while the desktop is idle.");
    this.reconnectFailures = 0;
    return reset;
  });

  /** Stops the helper and fails every waiting request. Run by the client's scope. */
  readonly dispose: Effect.Effect<void> = Effect.suspend(() => {
    this.disposed = true;
    const child = this.process;
    this.process = undefined;
    const disposed = requestError("AT-SPI helper is disposed.");
    if (child) failPending(child, disposed);
    for (const queued of [...this.lanes.high.splice(0), ...this.lanes.normal.splice(0)]) {
      Deferred.doneUnsafe(queued, Exit.fail(disposed));
    }
    return child ? terminateHelper(child) : Effect.void;
  });

  private request(
    method: string,
    params: Record<string, unknown>,
    priority: RequestPriority,
  ): Effect.Effect<unknown, AtspiHelperError> {
    return Effect.suspend(() => {
      if (this.disposed) return Effect.fail(requestError("AT-SPI helper is disposed."));
      if (this.queuedRequests >= REQUEST_QUEUE_LIMIT) {
        return Effect.fail(requestError("AT-SPI request queue is full."));
      }
      this.queuedRequests += 1;
      const turn = Deferred.makeUnsafe<void, AtspiHelperRequestError>();
      return Effect.uninterruptibleMask((restore) =>
        restore(
          this.waitTurn(priority, turn).pipe(
            // A request that waited out its operation's cancellation never starts.
            Effect.andThen(Effect.flatMap(desktopOperationSignal, checkDesktopSignal)),
            Effect.andThen(this.requestNow(method, params)),
          ),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              this.queuedRequests -= 1;
              this.leave(turn);
            }),
          ),
        ),
      );
    });
  }

  private waitTurn(
    priority: RequestPriority,
    turn: Deferred.Deferred<void, AtspiHelperRequestError>,
  ): Effect.Effect<void, AtspiHelperRequestError> {
    if (this.holder === undefined) {
      this.holder = turn;
      return Effect.void;
    }
    this.lanes[priority].push(turn);
    return Deferred.await(turn);
  }

  private leave(turn: Deferred.Deferred<void, AtspiHelperRequestError>): void {
    if (this.holder !== turn) {
      for (const lane of [this.lanes.high, this.lanes.normal]) {
        const index = lane.indexOf(turn);
        if (index !== -1) lane.splice(index, 1);
      }
      return;
    }
    const next = this.lanes.high.shift() ?? this.lanes.normal.shift();
    this.holder = next;
    if (next) Deferred.doneUnsafe(next, Exit.void);
  }

  private requestNow(
    method: string,
    params: Record<string, unknown>,
  ): Effect.Effect<unknown, AtspiHelperError> {
    return Effect.gen({ self: this }, function* () {
      if (this.disposed) return yield* requestError("AT-SPI helper is disposed.");
      if (this.unavailable && method !== HELPER_PROBE_METHOD) {
        if ((yield* Clock.currentTimeMillis) < this.unavailable.retryAt) {
          return yield* this.unavailableError();
        }
        // The retry window passed: one probe decides whether this request runs.
        yield* this.transportRequest(HELPER_PROBE_METHOD, {}).pipe(
          Effect.matchEffect({
            onSuccess: (result) => this.noteProbe(result),
            onFailure: (error) =>
              Effect.flatMap(Clock.currentTimeMillis, (now) =>
                this.unavailable && now < this.unavailable.retryAt
                  ? Effect.void
                  : this.latchUnavailable(`AT-SPI helper probe failed: ${error.message}`),
              ),
          }),
        );
        if (this.unavailable) return yield* this.unavailableError();
      }
      return yield* this.transportRequest(method, params);
    });
  }

  private transportRequest(
    method: string,
    params: Record<string, unknown>,
  ): Effect.Effect<unknown, AtspiHelperError> {
    return Effect.gen({ self: this }, function* () {
      const child = yield* this.ensureStarted;
      // Restart backoff can outlive the operation's permission or cancellation.
      // Check again before sending a write to the replacement helper.
      yield* assertDesktopOperationActive;
      const id = this.nextId++;
      const reply: Reply = Deferred.makeUnsafe();
      child.pending = { id, reply };
      // @effect-diagnostics-next-line preferSchemaOverJson:off - the helper's JSON-RPC frame.
      yield* Queue.offer(child.input, JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      const result = yield* Deferred.await(reply).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(this.requestTimeoutMs),
          orElse: () =>
            Effect.fail(
              requestError(`AT-SPI helper request timed out after ${this.requestTimeoutMs}ms.`),
            ),
        }),
        Effect.ensuring(
          Effect.sync(() => {
            if (child.pending?.id === id) child.pending = undefined;
          }),
        ),
        Effect.catchTag(
          "AtspiHelperRequestError",
          (error): Effect.Effect<never, AtspiHelperError> => {
            if (!error.refused) {
              return Effect.andThen(
                this.process === child ? this.resetProcess(error.message) : Effect.void,
                Effect.fail(error),
              );
            }
            // The peer answered, so the transport is healthy and the backoff is
            // cleared exactly as it would be for a success. Only the request failed.
            this.reconnectFailures = 0;
            if (
              error.code !== HELPER_BUS_UNAVAILABLE_ERROR &&
              error.code !== HELPER_PROTOCOL_MISMATCH_ERROR
            ) {
              return Effect.fail(error);
            }
            // Nothing about this machine changes by asking again right away.
            return this.latchUnavailable(
              error.code === HELPER_PROTOCOL_MISMATCH_ERROR
                ? protocolMismatch(undefined, error.message)
                : `AT-SPI is unavailable: ${error.message}`,
            ).pipe(Effect.andThen(Effect.suspend(() => Effect.fail(this.unavailableError()))));
          },
        ),
      );
      this.reconnectFailures = 0;
      return result;
    });
  }

  private get ensureStarted(): Effect.Effect<HelperProcess, AtspiHelperError> {
    return Effect.gen({ self: this }, function* () {
      if (this.process) return this.process;
      if (this.reconnectFailures > 0) {
        yield* Effect.sleep(
          Duration.millis(
            Math.min(
              HELPER_RECONNECT_MAX_DELAY_MS,
              HELPER_RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectFailures,
            ),
          ),
        );
      }
      if (this.disposed) return yield* requestError("AT-SPI helper is disposed.");
      return yield* this.startProcess;
    });
  }

  private get startProcess(): Effect.Effect<HelperProcess, AtspiHelperError> {
    return Effect.gen({ self: this }, function* () {
      const command = this.options.pythonPath ?? process.env.PATHWAY_ATSPI_PYTHON ?? "python3";
      const scriptPath =
        this.options.scriptPath ??
        process.env.PATHWAY_ATSPI_HELPER ??
        asarUnpackedPath(`${import.meta.dirname}/atspi_helper.py`);
      const processScope = yield* Scope.make();
      const child: HelperProcess = {
        scope: processScope,
        input: yield* Queue.make<string, Cause.Done>(),
        stderr: new StderrTail(),
        pending: undefined,
      };
      const handle = yield* this.spawner
        .spawn(
          ChildProcess.make(command, ["-u", scriptPath], {
            env: atspiHelperEnvironment(this.options),
            extendEnv: false,
            forceKillAfter: ATSPI_KILL_GRACE,
          }),
        )
        .pipe(Scope.provide(processScope), Effect.result);
      if (handle._tag === "Failure") {
        yield* Scope.close(processScope, Exit.void);
        // A spawn failure (no interpreter on PATH, not executable) before any
        // reply: nothing about this machine will change by retrying.
        const summary = `AT-SPI helper could not be started: ${handle.failure.message}`;
        if (!this.answered) yield* this.latchUnavailable(summary, child.stderr);
        this.reconnectFailures = Math.min(this.reconnectFailures + 1, 5);
        return yield* requestError(summary);
      }
      this.process = child;
      const helper = handle.success;
      const fork = <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.forkIn(effect, processScope, { startImmediately: true });
      // Streams can fail after a write has completed or after the helper was
      // replaced; only the current helper's failures reset anything.
      const onTransportError = (message: string) =>
        Effect.suspend(() => (this.process === child ? this.resetProcess(message) : Effect.void));
      yield* fork(
        Stream.fromQueue(child.input).pipe(
          Stream.map((line) => new TextEncoder().encode(`${line}\n`)),
          Stream.run(helper.stdin),
          Effect.catch((error) => onTransportError(error.message)),
        ),
      );
      yield* fork(
        this.readReplies(child, helper.stdout).pipe(
          Effect.catch((error) => onTransportError(error.message)),
        ),
      );
      // Collected regardless of which process is current: the diagnostic for a
      // helper that died is whatever it printed last.
      const stderrDrained = yield* fork(
        helper.stderr.pipe(
          Stream.decodeText,
          Stream.runForEach((chunk) => Effect.sync(() => child.stderr.push(chunk))),
          Effect.catch((error) => onTransportError(error.message)),
        ),
      );
      yield* fork(
        helper.exitCode.pipe(
          Effect.map((code) => ({ code: code as number | null, signal: null as string | null })),
          Effect.catch((error) =>
            Effect.succeed({ code: null, signal: exitSignal(error.message) }),
          ),
          Effect.tap(() =>
            Effect.timeoutOrElse(Effect.asVoid(Fiber.await(stderrDrained)), {
              duration: HELPER_STDERR_DRAIN,
              orElse: () => Effect.void,
            }),
          ),
          Effect.flatMap(({ code, signal }) => this.onExit(child, code, signal)),
        ),
      );
      return child;
    });
  }

  private readReplies(
    child: HelperProcess,
    stdout: Stream.Stream<Uint8Array, { readonly message: string }>,
  ): Effect.Effect<void, { readonly message: string }> {
    let buffered = "";
    return stdout.pipe(
      Stream.decodeText,
      Stream.runForEach((chunk) =>
        Effect.suspend(() => {
          buffered += chunk;
          let newline = buffered.indexOf("\n");
          while (newline !== -1) {
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            this.consumeLine(child, line);
            newline = buffered.indexOf("\n");
          }
          if (buffered.length > HELPER_MAX_FRAME_BYTES) {
            return Effect.fail({ message: "AT-SPI helper reply exceeded the frame limit." });
          }
          return Effect.void;
        }),
      ),
    );
  }

  private consumeLine(child: HelperProcess, line: string): void {
    if (this.process !== child) return;
    const message = parseJson(line);
    if (!isRecord(message) || !("id" in message)) return;
    const id = message.id;
    if (typeof id !== "number" && typeof id !== "string") return;
    this.answered = true;
    const pending = child.pending;
    if (!pending || pending.id !== id) return;
    child.pending = undefined;
    const error = isRecord(message.error) ? message.error : undefined;
    // Only a well-formed response envelope carrying an error is a refusal;
    // timeouts and transport failures come through their own paths.
    Deferred.doneUnsafe(
      pending.reply,
      error
        ? Exit.fail(
            new AtspiHelperRequestError({
              message:
                typeof error.message === "string" ? error.message : "AT-SPI helper request failed",
              ...(typeof error.code === "number" ? { code: error.code } : {}),
              refused: true,
            }),
          )
        : Exit.succeed(message.result),
    );
  }

  private onExit(
    child: HelperProcess,
    code: number | null,
    signal: string | null,
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (this.process !== child) return;
      const summary = `AT-SPI helper exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
      // A non-zero exit before the first reply is an interpreter that could
      // not run the script at all — a missing module, an unreadable file. A
      // signal before the first tree is a helper the desktop kills, the way
      // libatspi aborted on an unreachable bus: respawning it for every read
      // is a crash loop with a core dump each time. Our own stops never get
      // here — they detach the process first.
      if (
        (!this.answered && typeof code === "number" && code !== 0) ||
        (!this.treeAnswered && signal !== null)
      ) {
        yield* this.latchUnavailable(summary, child.stderr);
      }
      const trace = child.stderr.text();
      yield* this.resetProcess(trace ? `${summary}\n${trace}` : summary);
    });
  }

  /** Detaches the current helper, fails its request, and stops it in the background. */
  private resetProcess(message: string): Effect.Effect<void> {
    const child = this.process;
    this.process = undefined;
    this.reconnectFailures = Math.min(this.reconnectFailures + 1, 5);
    if (!child) return Effect.void;
    failPending(child, requestError(message));
    return Effect.asVoid(Effect.forkIn(terminateHelper(child), this.scope));
  }
}

function failPending(child: HelperProcess, error: AtspiHelperRequestError): void {
  const pending = child.pending;
  child.pending = undefined;
  if (pending) Deferred.doneUnsafe(pending.reply, Exit.fail(error));
}

/**
 * Ends the helper's stdin, then closes its scope: SIGTERM to its process
 * group, SIGKILL after the grace period.
 */
function terminateHelper(child: HelperProcess): Effect.Effect<void> {
  return Queue.end(child.input).pipe(Effect.andThen(Scope.close(child.scope, Exit.void)));
}

/** The last few kilobytes of a stream, for a diagnostic. */
class StderrTail {
  private tail = "";

  push(chunk: string): void {
    this.tail = `${this.tail}${chunk}`.slice(-HELPER_STDERR_TAIL_CHARS);
  }

  text(): string {
    return this.tail.trim();
  }
}

function requestError(message: string): AtspiHelperRequestError {
  return new AtspiHelperRequestError({ message, refused: false });
}

/** The signal named in the spawner's "interrupted due to receipt of signal" failure. */
function exitSignal(message: string): string {
  return /'(SIG[A-Z0-9]+)'/.exec(message)?.[1] ?? "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The window descriptor the helper matches against the live AT-SPI desktop. */
function helperWindow(window: ComputerWindow): Record<string, unknown> {
  return {
    id: window.id,
    title: window.title,
    appName: window.appName ?? null,
    pid: window.pid ?? null,
    bounds: window.bounds,
  };
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isAtspiWindowTree(value: unknown): value is AtspiWindowTree {
  if (!isRecord(value)) return false;
  return (
    typeof value.windowId === "string" &&
    isClientSize(value.clientSize) &&
    isAtspiNode(value.root) &&
    isAtspiWindowTreeStatus(value.status) &&
    (value.truncated === undefined || typeof value.truncated === "boolean") &&
    (value.reason === undefined || typeof value.reason === "string")
  );
}

function isClientSize(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.width === "number" &&
    Number.isFinite(value.width) &&
    value.width > 0 &&
    typeof value.height === "number" &&
    Number.isFinite(value.height) &&
    value.height > 0
  );
}

function isAtspiWindowTreeStatus(value: unknown): boolean {
  return (
    value === undefined || value === "complete" || value === "partial" || value === "unavailable"
  );
}

function isAtspiNode(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.role === "string" &&
    (value.label === null || typeof value.label === "string") &&
    (value.value === null || typeof value.value === "string") &&
    (value.description === null || typeof value.description === "string") &&
    isRect(value.frame) &&
    (value.i === undefined || isChildIndex(value.i)) &&
    (value.editable === undefined || typeof value.editable === "boolean") &&
    (value.truncated === undefined || typeof value.truncated === "boolean") &&
    Array.isArray(value.children) &&
    value.children.every(isAtspiNode)
  );
}

function isChildIndex(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function protocolMismatch(protocol: unknown, detail?: string): string {
  return (
    `The AT-SPI helper speaks protocol ${JSON.stringify(protocol ?? "unknown")}; this server ` +
    `needs ${ATSPI_HELPER_PROTOCOL}. The helper script does not match this build` +
    (detail ? `: ${detail}` : ".")
  );
}

function isRect(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.x === "number" &&
    Number.isFinite(value.x) &&
    typeof value.y === "number" &&
    Number.isFinite(value.y) &&
    typeof value.width === "number" &&
    Number.isFinite(value.width) &&
    value.width >= 0 &&
    typeof value.height === "number" &&
    Number.isFinite(value.height) &&
    value.height >= 0
  );
}
