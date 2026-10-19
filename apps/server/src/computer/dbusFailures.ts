/**
 * Reading a failed plugin-host call: was it the call, or the connection?
 *
 * The answers decide recovery. A connection-level failure drops the proxy and
 * reconnects; a method-level one is the plugin (or KWin, or the bus daemon)
 * refusing this call, and tearing down a working connection over it strands
 * whatever the refused call was in the middle of. The readers are duck-typed
 * over `unknown` on purpose: a failure reaches them wrapped (a backend error
 * whose `cause` is the bus error) as often as bare, and they follow `cause`
 * down to whatever layer carried the D-Bus error name.
 *
 * @module computer/dbusFailures
 */
import * as Schema from "effect/Schema";

import { ComputerBackendError } from "./computerErrors.ts";
import { COMPUTER_SERVICE_OWNER_MISMATCH_ERROR, isCaptureMethod } from "./kwinDbus.ts";

/** Every error name the Pathway plugin raises shares this prefix. */
export const COMPUTER_PLUGIN_ERROR_PREFIX = "com.spiritdevs.pathway.ComputerUse.Error.";

export const CONNECTION_DBUS_ERROR_TYPES = new Set([
  "org.freedesktop.DBus.Error.NoReply",
  "org.freedesktop.DBus.Error.Disconnected",
  "org.freedesktop.DBus.Error.IOError",
  "org.freedesktop.DBus.Error.Timeout",
  // A KWin crash does not drop this backend's session-bus connection — only
  // KWin's bus names vanish, so calls to the stale proxy fail with these two
  // instead of a disconnect. The remedy is the connection-level one: drop the
  // proxy, reconnect, and re-load the plugin into the restarted compositor.
  "org.freedesktop.DBus.Error.ServiceUnknown",
  "org.freedesktop.DBus.Error.NameHasNoOwner",
]);

/**
 * The D-Bus errors that mean "the generation this proxy is pinned to is gone":
 * the plugin was unloaded (object and interface vanish from the owner), or was
 * reloaded and the new instance does not know this connection's token.
 * Method-level as far as the bus is concerned, but every later call fails the
 * same way, so the remedy is a fresh connect and a new authentication.
 */
const STALE_GENERATION_DBUS_ERROR_TYPES = new Set([
  `${COMPUTER_PLUGIN_ERROR_PREFIX}Unauthorized`,
  "org.freedesktop.DBus.Error.UnknownObject",
  "org.freedesktop.DBus.Error.UnknownInterface",
]);

/** Socket-level codes a dead bus connection surfaces through dbus-next. */
const CONNECTION_ERROR_CODES = new Set(["ENOENT", "ECONNRESET", "ECONNREFUSED", "EPIPE"]);

/**
 * Whether a failure means the connection to the compositor is gone, as
 * opposed to a call the compositor answered with a refusal.
 *
 * Deliberately closed: a failure this table does not know is a call-level
 * failure. It used to default the other way, and an unrecognised error — an
 * operation cancelled mid-drag, a JSON parse error, a validation failure —
 * tore the connection down and reconnected, with the dragged button left
 * pressed on the seat while the proxy was rebuilt.
 */
export function isConnectionLevelFailure(error: unknown): boolean {
  if (errorField(error, "_tag") === "KWinDbusTimeoutError") {
    return !isCaptureMethod(String(errorField(error, "methodName")));
  }
  if (hasConnectionLevelMarker(error)) return true;
  if (isMethodLevelDbusError(error)) return false;

  const type = dbusErrorType(error);
  if (type && CONNECTION_DBUS_ERROR_TYPES.has(type)) return true;

  const code = errorField(error, "code");
  if (typeof code === "string" && CONNECTION_ERROR_CODES.has(code)) return true;

  const message = errorMessage(error);
  if (/(?:closed|disconnected|not connected).*(?:bus|stream|socket|connection)/i.test(message))
    return true;
  if (
    /(?:bus|stream|socket|connection).*(?:closed|disconnected|not connected|reset|refused)/i.test(
      message,
    )
  )
    return true;

  const cause = errorCause(error);
  if (cause !== undefined && cause !== error) return isConnectionLevelFailure(cause);
  return false;
}

export function isMethodLevelDbusError(error: unknown): boolean {
  const type = dbusErrorType(error);
  if (type?.startsWith(COMPUTER_PLUGIN_ERROR_PREFIX)) return true;
  if (type?.startsWith("org.freedesktop.DBus.Error.")) {
    return !CONNECTION_DBUS_ERROR_TYPES.has(type);
  }
  const cause = errorCause(error);
  return cause !== undefined && cause !== error ? isMethodLevelDbusError(cause) : false;
}

export function isUnknownMethodDbusError(error: unknown): boolean {
  if (dbusErrorType(error) === "org.freedesktop.DBus.Error.UnknownMethod") return true;
  const cause = errorCause(error);
  return cause !== undefined && cause !== error ? isUnknownMethodDbusError(cause) : false;
}

export function isStaleGenerationDbusError(error: unknown): boolean {
  const type = dbusErrorType(error);
  if (type !== undefined && STALE_GENERATION_DBUS_ERROR_TYPES.has(type)) return true;
  const cause = errorCause(error);
  return cause !== undefined && cause !== error ? isStaleGenerationDbusError(cause) : false;
}

/**
 * The service owner check refused the connection. Not terminal for
 * supervision (the owner can be a generation caught mid-reload, so the timer
 * checks again from scratch), but method-level for the in-call ladder.
 */
export function isServiceOwnerMismatch(error: unknown): boolean {
  return dbusErrorType(error) === COMPUTER_SERVICE_OWNER_MISMATCH_ERROR;
}

/** The D-Bus error name a failure carries, from its `type` or its message. */
export function dbusErrorType(error: unknown): string | undefined {
  const type = errorField(error, "type");
  if (typeof type === "string") return type;
  return errorMessage(error).match(
    /(?:com\.spiritdevs\.pathway\.ComputerUse|org\.freedesktop\.DBus)\.Error\.[\w.]+/,
  )?.[0];
}

/** The `text` a D-Bus error reply carried, which dbus-next also uses as its message. */
export function dbusErrorText(error: unknown): string {
  const text = errorField(error, "text");
  if (typeof text === "string" && text.length > 0) return text;
  return errorMessage(error);
}

export function errorCause(error: unknown): unknown {
  return errorField(error, "cause");
}

export function isDormantBackendError(error: unknown): boolean {
  return Schema.is(ComputerBackendError)(error) && error.dormant;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorField(error: unknown, field: string): unknown {
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)[field]
    : undefined;
}

function hasConnectionLevelMarker(error: unknown): boolean {
  return errorField(error, "connectionLevel") === true;
}
