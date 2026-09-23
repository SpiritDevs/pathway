/**
 * The typed failures of the computer domain.
 *
 * Synara spreads these across the modules that raise them. They live together
 * here because the backend interface, targeting and the manager all fail with
 * them, and one module keeps the import graph acyclic. Subclasses keep Synara's
 * hierarchy, so a lease refusal is still a `ComputerBackendError` (and caught by
 * `Effect.catchTag("ComputerBackendError")`), and a denylist refusal is still a
 * `ComputerTargetError`. The constructors are overridden on purpose: these
 * errors never decode from the wire (the RPC layer maps them to contract
 * errors), so the diagnostic's decoding concern does not apply.
 *
 * @module computer/computerErrors
 */
import {
  ComputerInputPause,
  ComputerRect,
  type ComputerSpaceErrorCode,
} from "@spiritdevs/contracts";
import type { CuaActionDiagnostics } from "@spiritdevs/shared/cuaActionDiagnostics";
import type { CuaEffect } from "@spiritdevs/shared/cuaDriverProtocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Flag = Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false)));

export class ComputerBackendError extends Schema.TaggedErrorClass<ComputerBackendError>()(
  "ComputerBackendError",
  {
    message: Schema.String,
    retryable: Flag,
    /**
     * The failure is a decision, not a fault: the backend's desktop is
     * deliberately not running right now, and only a real use may start it.
     * Automatic supervision that sees this must report the message and stand
     * down, because retrying cannot conjure a desktop the backend refused to
     * boot.
     */
    dormant: Flag,
    /**
     * The call the desktop declined, when the failure was a refusal rather than
     * a fault. A refusal means nothing was injected, which is what lets a caller
     * explain the miss instead of reporting a generic failure.
     */
    rejectedOperation: Schema.optional(Schema.String),
    /**
     * The desktop refused because the OS has not granted Pathway a privacy
     * permission it needs. Only the backend can tell this apart from an
     * ordinary action failure, so it is marked here rather than guessed from
     * message text further up.
     */
    setupRequired: Flag,
    /** A recoverable input refusal; observation remains available. */
    inputPause: Schema.optional(ComputerInputPause),
    /**
     * The call was refused because the thread's computer control was disabled:
     * the kill switch, not a fault. The audit seam reads this to keep disabled
     * state out of the log.
     */
    controlRevoked: Flag,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Refusal raised when another thread owns the desktop. It stays a
 * `ComputerBackendError` so every catch site keeps classifying it, and
 * explicitly discourages immediate retries: repeating the same refusal cannot
 * free the other conversation's desktop lease.
 */
export class ComputerLeaseError extends ComputerBackendError {
  readonly code = "computer_controlled_by_other_thread";

  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(targetOnly = false) {
    super({
      message:
        (targetOnly
          ? "This application or window is controlled by another conversation; "
          : "The shared pointer and focused keyboard are controlled by another conversation; ") +
        "no input was sent. Do not retry this blocked action or switch tools to bypass " +
        "the lease. Wait until that conversation's turn ends. Reading the desktop still " +
        "works. Background actions on independently owned applications remain available.",
      retryable: false,
    });
  }
}

/**
 * A Cua action that failed or whose effect is uncertain. The message carries
 * the effect verdict so a model reading only text still learns that automatic
 * replay is forbidden.
 */
export class CuaActionError extends ComputerBackendError {
  readonly effect: CuaEffect;
  readonly code: string;
  readonly diagnostics: CuaActionDiagnostics | undefined;
  readonly layer: "driver-host" | "native-driver" | undefined;
  readonly waitSeconds: number | undefined;

  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(
    message: string,
    effect: CuaEffect,
    code = "cua_action_failed",
    inputPause?: ComputerInputPause,
    diagnostics?: CuaActionDiagnostics,
    layer?: "driver-host" | "native-driver",
    waitSeconds?: number,
  ) {
    super({
      message: `${message} [effect=${effect}; automatic replay is forbidden]`,
      retryable: false,
      ...((effect === "not-dispatched" || code === "focus_restore_failed") && inputPause
        ? { inputPause }
        : {}),
    });
    this.effect = effect;
    this.code = code;
    this.diagnostics = diagnostics;
    this.layer = layer;
    this.waitSeconds = waitSeconds;
  }
}

export type ComputerTargetErrorCode =
  | ComputerSpaceErrorCode
  | "computer_target_invalid"
  | "computer_target_not_found"
  | "computer_target_ambiguous"
  | "computer_target_offscreen"
  /** The named window is covered at the point and the desktop could not raise it. */
  | "computer_target_occluded"
  /** The desktop declined to deliver input to the named window, and sent none. */
  | "computer_target_refused"
  /**
   * The target belongs to a denylisted surface (a password manager or OS
   * security UI) and the access was refused before it could dispatch or
   * disclose anything. There is no override in this build.
   */
  | "computer_denylist_refused"
  /** The target's app needs the user's once-per-app consent this turn; nothing was sent. */
  | "computer_app_approval_required";

export const ComputerTargetCandidate = Schema.Struct({
  label: Schema.String,
  role: Schema.String,
  windowId: Schema.NullOr(Schema.String),
  onScreen: Schema.Boolean,
  frame: ComputerRect,
});
export type ComputerTargetCandidate = typeof ComputerTargetCandidate.Type;

export interface ComputerTargetErrorInput {
  readonly code: ComputerTargetErrorCode;
  readonly message: string;
  readonly candidates?: readonly ComputerTargetCandidate[];
  readonly notFound?: boolean;
  readonly unresolvedTextControl?: boolean;
}

/** One candidate as a single line, short enough that sixteen of them still read. */
function describeCandidate(candidate: ComputerTargetCandidate): string {
  const window =
    candidate.windowId === null ? "" : ` in window ${JSON.stringify(candidate.windowId)}`;
  return `${candidate.role} ${JSON.stringify(candidate.label)}${window}`;
}

function messageWithCandidates(
  message: string,
  candidates: readonly ComputerTargetCandidate[],
): string {
  if (candidates.length === 0) return message;
  return `${message} Controls in the accessibility tree: ${candidates.map(describeCandidate).join("; ")}.`;
}

/**
 * A target that could not be resolved to one safe point. Candidates go in the
 * message, not only in the field beside it: the model often sees only the
 * text, and the refuse-rather-than-guess design depends on the caller seeing
 * what it should have asked for.
 */
export class ComputerTargetError extends Schema.TaggedErrorClass<ComputerTargetError>()(
  "ComputerTargetError",
  {
    code: Schema.String,
    message: Schema.String,
    candidates: Schema.Array(ComputerTargetCandidate),
    notFound: Schema.Boolean,
    /**
     * The window exists but its text field could not be singled out from the
     * accessibility tree. Distinct from a missing window: the keyboard can still
     * reach whatever field the app itself has focused.
     */
    unresolvedTextControl: Schema.Boolean,
  },
) {
  declare readonly code: ComputerTargetErrorCode;

  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(input: ComputerTargetErrorInput) {
    const candidates = input.candidates ?? [];
    super({
      code: input.code,
      message: messageWithCandidates(input.message, candidates),
      candidates,
      notFound: input.notFound ?? input.code === "computer_target_not_found",
      unresolvedTextControl: input.unresolvedTextControl ?? false,
    });
  }
}

export class ComputerSpaceError extends ComputerTargetError {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(code: ComputerSpaceErrorCode, message: string) {
    super({ code, message });
  }
}

/**
 * The typed refusal every denylisted access shares. It stays a
 * `ComputerTargetError` so the target-error branch keeps the code on the wire;
 * `app` names the refused surface for the audit record and the message.
 */
export class ComputerDenylistError extends ComputerTargetError {
  /** The displayable identity that was refused: name or bundle id. */
  readonly app: string;

  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(app: string, matched: string) {
    super({
      code: "computer_denylist_refused",
      message:
        `${app} is on the computer-control denylist (${matched}): password managers ` +
        "and OS security surfaces are refused, with no override in this build.",
    });
    this.app = app;
  }
}

/**
 * Input for an app the turn may not drive yet (ADR 0043's once-per-app
 * consent). Refused before dispatch; the next call asks the user for `app`.
 */
export class ComputerAppApprovalRequiredError extends ComputerTargetError {
  readonly app: string;

  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(app: string) {
    super({
      code: "computer_app_approval_required",
      message:
        `Computer needs the user's approval to use ${app} in this task, so nothing was sent. ` +
        "Call again to ask the user; the call waits for their answer.",
    });
    this.app = app;
  }
}

/** Every failure a computer operation can surface to its caller. */
export type ComputerOperationError = ComputerBackendError | ComputerTargetError;

// `Schema.is` is only valid on the two root classes: effect-smol memoizes the
// class schema on the base, so `Schema.is(Subclass)` accepts every sibling.
// The subclasses are told apart with `instanceof`.

export function isComputerLeaseError(error: unknown): error is ComputerLeaseError {
  // @effect-diagnostics-next-line instanceOfSchema:off -- Schema.is would accept any ComputerBackendError.
  return error instanceof ComputerLeaseError;
}

export function isCuaActionError(error: unknown): error is CuaActionError {
  // @effect-diagnostics-next-line instanceOfSchema:off -- Schema.is would accept any ComputerBackendError.
  return error instanceof CuaActionError;
}

export function isComputerSpaceError(error: unknown): error is ComputerSpaceError {
  // @effect-diagnostics-next-line instanceOfSchema:off -- Schema.is would accept any ComputerTargetError.
  return error instanceof ComputerSpaceError;
}

export function isComputerDenylistError(error: unknown): error is ComputerDenylistError {
  // @effect-diagnostics-next-line instanceOfSchema:off -- Schema.is would accept any ComputerTargetError.
  return error instanceof ComputerDenylistError;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
