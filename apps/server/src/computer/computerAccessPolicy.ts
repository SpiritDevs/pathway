/**
 * The environment's Computer access policy (ADR 0041): which paired clients may
 * start Computer tasks and turn on Computer control. Watching, answering
 * approvals and Stop are never restricted by it, so callers only apply it to
 * the ways in.
 *
 * @module computer/computerAccessPolicy
 */
import {
  AuthAccessWriteScope,
  AuthComputerOperateScope,
  AuthOrchestrationOperateScope,
  type AuthEnvironmentScope,
  type ComputerAccessPolicy,
  EnvironmentAuthorizationError,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";

/** Why a client was refused, with the two ways out. Shared by every Computer surface. */
export const COMPUTER_ACCESS_DENIED_MESSAGE =
  "This device isn't allowed to use Computer on this environment. Re-pair it with “Use Computer” enabled, or ask an admin to change the Computer access policy in Settings.";

/** The scope a refusal names: the one that would have admitted the client. */
export function computerAccessRequiredScope(policy: ComputerAccessPolicy): AuthEnvironmentScope {
  switch (policy) {
    case "any-operator":
      return AuthOrchestrationOperateScope;
    case "scoped":
      return AuthComputerOperateScope;
    case "admins-only":
      return AuthAccessWriteScope;
  }
}

/**
 * Whether a session holding `scopes` may use Computer under `policy`. Admin
 * sessions paired before `computer:operate` existed still pass `scoped`.
 */
export function canUseComputer(
  policy: ComputerAccessPolicy,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): boolean {
  switch (policy) {
    case "any-operator":
      return scopes.includes(AuthOrchestrationOperateScope);
    case "scoped":
      return scopes.includes(AuthComputerOperateScope) || scopes.includes(AuthAccessWriteScope);
    case "admins-only":
      return scopes.includes(AuthAccessWriteScope);
  }
}

export const computerAccessDenied = (policy: ComputerAccessPolicy) =>
  new EnvironmentAuthorizationError({
    message: COMPUTER_ACCESS_DENIED_MESSAGE,
    requiredScope: computerAccessRequiredScope(policy),
  });

/** Succeeds when the policy admits `scopes`, and fails with the re-pair hint otherwise. */
export const requireComputerAccess = (
  policy: ComputerAccessPolicy,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): Effect.Effect<void, EnvironmentAuthorizationError> =>
  canUseComputer(policy, scopes) ? Effect.void : Effect.fail(computerAccessDenied(policy));

const POLICIES_BY_STRICTNESS: ReadonlyArray<ComputerAccessPolicy> = [
  "any-operator",
  "scoped",
  "admins-only",
];

/** Whether `policy` admits fewer senders than `than`. */
export const isStricterComputerAccess = (
  policy: ComputerAccessPolicy,
  than: ComputerAccessPolicy,
): boolean => POLICIES_BY_STRICTNESS.indexOf(policy) > POLICIES_BY_STRICTNESS.indexOf(than);

/**
 * The strictest policy `scopes` satisfy, checked against the current one: the
 * clearance a run is frozen with, or the re-pair hint when the sender is not
 * admitted now.
 */
export const computerClearance = (
  policy: ComputerAccessPolicy,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): Effect.Effect<ComputerAccessPolicy, EnvironmentAuthorizationError> => {
  const clearance = POLICIES_BY_STRICTNESS.findLast((candidate) =>
    canUseComputer(candidate, scopes),
  );
  return clearance === undefined || isStricterComputerAccess(policy, clearance)
    ? Effect.fail(computerAccessDenied(policy))
    : Effect.succeed(clearance);
};
