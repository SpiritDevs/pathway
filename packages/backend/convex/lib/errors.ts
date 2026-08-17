/**
 * Every refusal leaves this deployment as a `ConvexError` carrying a stable code, because clients
 * branch on it: `upgrade-required` forces an update, and a rejection code lands in the
 * rejected-changes panel.
 *
 * @module lib/errors
 */
import { ConvexError } from "convex/values";

/** A type alias, not an interface: `ConvexError` payloads must satisfy Convex's `Value` shape. */
export type BackendErrorData = {
  code: string;
  message: string;
};

export function backendError(code: string, message: string): ConvexError<BackendErrorData> {
  return new ConvexError({ code, message });
}

/** Marks a signature that exists so callers can be written against it, but has no body yet. */
export function notImplemented(what: string): never {
  throw backendError("not-implemented", `${what} is not implemented yet.`);
}
