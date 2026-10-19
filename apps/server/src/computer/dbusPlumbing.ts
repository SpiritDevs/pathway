/**
 * The bits of D-Bus mechanics every desktop path needs and none of them should
 * own a copy of.
 *
 * Four things live here. Unwrapping a variant, because a value read off the
 * bus arrives wrapped or not depending on which transport and which library
 * carried it, and every parser above this has to see through that the same
 * way. The typed failure of a call the bus did answer, so the classifiers above
 * read one shape whatever library raised it. The timeout, because a D-Bus call
 * that is never answered is otherwise an effect that never completes and a
 * session that never recovers. And the connection watch, because a bus that
 * dies under a call is the same unanswered call, and waiting out its timeout
 * to learn that is needless.
 *
 * The timeout deliberately does not decide what a timeout *is*. Each caller's
 * error type carries its own recovery: a plugin timeout is connection-level and
 * drives a reconnect, while a probe's timeout is a plain answer of "not here".
 * Those are not cosmetic differences, so the mechanism is shared and the
 * meaning is not.
 *
 * @module computer/dbusPlumbing
 */
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ComputerBackendError } from "./computerErrors.ts";

/** Unwraps a `dbus-next` variant, however many layers deep it was wrapped. */
export function unwrapDbusValue(value: unknown): unknown {
  if (isDbusVariant(value)) {
    return unwrapDbusValue((value as { readonly value: unknown }).value);
  }
  return value;
}

function isDbusVariant(
  value: unknown,
): value is { readonly signature: string; readonly value: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly signature?: unknown }).signature === "string" &&
    "value" in value
  );
}

/**
 * A call the bus answered with a failure, or one that could not be made at
 * all. `type` is the D-Bus error name when the reply carried one
 * (`org.freedesktop.DBus.Error.UnknownMethod`), `text` the reply's own text,
 * and `code` a socket code (`ECONNRESET`) when the transport raised it: the
 * three fields the connection-level classifiers read.
 */
export class DbusCallError extends Schema.TaggedErrorClass<DbusCallError>()("DbusCallError", {
  message: Schema.String,
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * A rejection from `dbus-next` (or anything else carrying its fields) as a
 * `DbusCallError`. A `DBusError` keeps the error name in `type` and the reply
 * text in `text`; a socket failure keeps its code in `code`.
 */
export function toDbusCallError(error: unknown): DbusCallError {
  if (Schema.is(DbusCallError)(error)) return error;
  const field = (name: string): string | undefined => {
    const value =
      typeof error === "object" && error !== null
        ? (error as Record<string, unknown>)[name]
        : undefined;
    return typeof value === "string" ? value : undefined;
  };
  return new DbusCallError({
    message: error instanceof Error ? error.message : String(error),
    type: field("type"),
    text: field("text"),
    code: field("code"),
    cause: error,
  });
}

/**
 * `effect`, but failing with `onTimeout()` if it has not completed within
 * `timeoutMs`. The call is interrupted when the deadline wins, so a settled or
 * abandoned call leaves nothing behind. Failures the bus did report pass
 * through untouched; a caller that speaks in other errors maps them itself.
 */
export const withDbusTimeout = <A, E, R, E2>(
  effect: Effect.Effect<A, E, R>,
  timeoutMs: number,
  onTimeout: () => E2,
): Effect.Effect<A, E | E2, R> =>
  Effect.timeoutOrElse(effect, {
    duration: Duration.millis(timeoutMs),
    orElse: () => Effect.fail(onTimeout()),
  });

/**
 * The bus connection itself ended under a call: the peer did not answer
 * because nothing carries the answer any more. `connectionLevel` is what the
 * backends read to drop the connection and reconnect instead of blaming the
 * call.
 */
export class DbusConnectionClosedError extends Schema.TaggedErrorClass<DbusConnectionClosedError>()(
  "DbusConnectionClosedError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  readonly connectionLevel = true;

  override get message(): string {
    const cause = this.cause;
    const detail =
      cause === undefined ? "" : `: ${cause instanceof Error ? cause.message : String(cause)}`;
    return `The D-Bus connection closed${detail}.`;
  }
}

/** Why a watched call ended without an answer: a drop, or this side's own release. */
export type DbusConnectionEnded = DbusConnectionClosedError | ComputerBackendError;

/**
 * Liveness of one `dbus-next` connection, which the library does not report.
 *
 * dbus-next 0.10.2 never emits `disconnect`, and a socket that reaches EOF
 * fails nothing: a call already waiting keeps its reply handler forever, and a
 * call made afterwards is swallowed with an `error` event instead of a
 * rejection. So a dead bus looked alive until each call's own timeout (up to a
 * minute for a large capture). The truth is on the transport underneath —
 * `_connection` emits `end` on EOF and its stream `close` once the socket is
 * gone — and this watch turns it into one closure: `onClosed` fires once, and
 * every call running through `guard` fails at once, including calls started
 * after the drop.
 */
export interface DbusConnectionWatch {
  readonly isClosed: () => boolean;
  /**
   * `effect`, failed the moment the connection ends if it has not completed by
   * then (and interrupted). On an already-ended connection `effect` never runs.
   */
  readonly guard: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | DbusConnectionEnded, R>;
  /** Fires at most once, when the connection drops — never after `release`. */
  readonly onClosed: (listener: (error: DbusConnectionClosedError) => void) => () => void;
  /**
   * This side is ending the connection on purpose: calls still waiting, and
   * any made later, fail with `reason` rather than a drop, and no `onClosed`
   * listener fires. A no-op once the connection has ended.
   */
  readonly release: (reason: ComputerBackendError) => void;
}

/**
 * Starts watching `bus` (a `dbus-next` MessageBus). The listeners are plain
 * emitter callbacks: they run on the socket's own events, outside any fiber,
 * so the closure they record is settled synchronously.
 */
export function watchDbusConnection(bus: object): DbusConnectionWatch {
  const ended = Deferred.makeUnsafe<never, DbusConnectionEnded>();
  const listeners = new Set<(error: DbusConnectionClosedError) => void>();

  const end = (reason: DbusConnectionEnded, dropped: boolean) => {
    if (Deferred.isDoneUnsafe(ended)) return;
    if (dropped && reason._tag === "DbusConnectionClosedError") {
      for (const listener of listeners) {
        try {
          listener(reason);
        } catch {
          // The emitter calling this is a socket's: a throw here would
          // surface as an uncaught exception from inside the stream.
        }
      }
      listeners.clear();
    }
    Deferred.doneUnsafe(ended, Effect.fail(reason));
  };
  const drop = (cause?: unknown) =>
    end(new DbusConnectionClosedError(cause === undefined ? {} : { cause }), true);

  const listen = (target: unknown, event: string, handler: (...args: unknown[]) => void) => {
    if (isEmitter(target)) target.on(event, handler);
  };
  const onError = (error: unknown, detail?: unknown) => {
    if (!isMessageLevelBusError(error, detail)) drop(error);
  };
  const onEnd = () => drop();
  listen(bus, "error", onError);
  listen(bus, "disconnect", onEnd);
  const connection = (bus as { readonly _connection?: unknown })._connection;
  listen(connection, "end", onEnd);
  listen((connection as { readonly stream?: unknown } | undefined)?.stream, "close", onEnd);

  return {
    isClosed: () => Deferred.isDoneUnsafe(ended),
    guard: (effect) =>
      Effect.suspend(() =>
        Deferred.isDoneUnsafe(ended)
          ? Deferred.await(ended)
          : Effect.raceFirst(effect, Deferred.await(ended)),
      ),
    onClosed: (listener) => {
      if (Deferred.isDoneUnsafe(ended)) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    release: (reason) => end(reason, false),
  };
}

/**
 * An `error` the bus emits about one message rather than the connection.
 *
 * dbus-next funnels everything through the bus's `error` event, and two kinds
 * leave the connection working: a message it failed to decode (emitted with a
 * description as a second argument, and the stream reads on) and a D-Bus error
 * reply to its own AddMatch/RemoveMatch bookkeeping (a `DBusError`, which
 * carries the error name as `type`). Taking either for a drop would tear down
 * a healthy connection and every call on it. Anything else — a socket error,
 * a failed handshake, a write to a closed stream — ends the connection, and
 * the transport's own `end`/`close` may never follow a handshake failure, so
 * those still drop here.
 */
function isMessageLevelBusError(error: unknown, detail: unknown): boolean {
  if (detail !== undefined) return true;
  return (
    error instanceof Error &&
    error.name === "DBusError" &&
    typeof (error as { readonly type?: unknown }).type === "string"
  );
}

interface Emitter {
  on(event: string, handler: (...args: unknown[]) => void): unknown;
}

function isEmitter(value: unknown): value is Emitter {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { on?: unknown }).on === "function"
  );
}
