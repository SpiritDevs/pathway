import {
  AuthAccessWriteScope,
  AuthAdministrativeScopes,
  AuthComputerOperateScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  canUseComputer,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { COMPUTER_ACCESS_DENIED_MESSAGE, requireComputerAccess } from "./computerAccessPolicy.ts";

const operatorWithoutComputer: ReadonlyArray<AuthEnvironmentScope> =
  AuthStandardClientScopes.filter((scope) => scope !== AuthComputerOperateScope);
// An admin pairing from before computer:operate existed.
const legacyAdmin: ReadonlyArray<AuthEnvironmentScope> = AuthAdministrativeScopes.filter(
  (scope) => scope !== AuthComputerOperateScope,
);

describe("Computer access policy", () => {
  it("admits any operator under any-operator", () => {
    expect(canUseComputer("any-operator", operatorWithoutComputer)).toBe(true);
    expect(canUseComputer("any-operator", [AuthOrchestrationReadScope])).toBe(false);
  });

  it("admits computer:operate or an admin under scoped", () => {
    expect(canUseComputer("scoped", AuthStandardClientScopes)).toBe(true);
    expect(canUseComputer("scoped", legacyAdmin)).toBe(true);
    expect(canUseComputer("scoped", operatorWithoutComputer)).toBe(false);
  });

  it("admits only admins under admins-only", () => {
    expect(canUseComputer("admins-only", legacyAdmin)).toBe(true);
    expect(canUseComputer("admins-only", AuthStandardClientScopes)).toBe(false);
  });

  it.effect("refuses with the re-pair hint and the scope that would have admitted", () =>
    Effect.gen(function* () {
      const cases = [
        ["any-operator", AuthOrchestrationOperateScope],
        ["scoped", AuthComputerOperateScope],
        ["admins-only", AuthAccessWriteScope],
      ] as const;
      for (const [policy, requiredScope] of cases) {
        const error = yield* Effect.flip(
          requireComputerAccess(policy, [AuthOrchestrationReadScope]),
        );
        expect(error).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          message: COMPUTER_ACCESS_DENIED_MESSAGE,
          requiredScope,
        });
      }
      yield* requireComputerAccess("scoped", [AuthComputerOperateScope]);
    }),
  );
});
