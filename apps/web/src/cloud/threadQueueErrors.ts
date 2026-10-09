import { ConvexError } from "convex/values";

const definitiveQueueRejections = new Set([
  "invalid-arguments",
  "submission-conflict",
  "entity-not-found",
  "ambiguous-queue",
  "binding-unavailable",
  "permission-denied",
  "thread-unavailable",
  "attachment-unavailable",
  "invalid-command-state",
  "destination-changed",
  "provider-unavailable",
  "environment-unavailable",
  "not-a-member",
  "company-unavailable",
  "user-not-provisioned",
]);
export function isDefinitiveQueueRejection(error: unknown) {
  return (
    error instanceof ConvexError &&
    error.data !== null &&
    typeof error.data === "object" &&
    "code" in error.data &&
    typeof error.data.code === "string" &&
    definitiveQueueRejections.has(error.data.code)
  );
}

/** The cloud no longer has the thread or message, so a delete has nothing left to do there. */
export function isQueueEntityNotFound(error: unknown) {
  return (
    error instanceof ConvexError &&
    error.data !== null &&
    typeof error.data === "object" &&
    "code" in error.data &&
    error.data.code === "entity-not-found"
  );
}
