import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ComputerBackendError,
  ComputerDenylistError,
  ComputerLeaseError,
  ComputerSpaceError,
  ComputerTargetError,
  CuaActionError,
  isComputerDenylistError,
  isComputerLeaseError,
  isComputerSpaceError,
  isCuaActionError,
} from "./computerErrors.ts";

describe("computer error guards", () => {
  const backend = new ComputerBackendError({ message: "backend" });
  const lease = new ComputerLeaseError();
  const action = new CuaActionError("action", "not-dispatched");
  const target = new ComputerTargetError({ code: "computer_target_invalid", message: "target" });
  const space = new ComputerSpaceError("computer_space_not_found", "space");
  const denylist = new ComputerDenylistError("Keychain Access", "com.apple.keychainaccess");

  it("Schema.is on a subclass accepts every sibling, so the guards use instanceof", () => {
    expect(Schema.is(ComputerLeaseError)(backend)).toBe(true);
    expect(Schema.is(ComputerSpaceError)(target)).toBe(true);
  });

  it("tells each subclass apart from its root and siblings", () => {
    expect([backend, lease, action].map(isComputerLeaseError)).toEqual([false, true, false]);
    expect([backend, lease, action].map(isCuaActionError)).toEqual([false, false, true]);
    expect([target, space, denylist].map(isComputerSpaceError)).toEqual([false, true, false]);
    expect([target, space, denylist].map(isComputerDenylistError)).toEqual([false, false, true]);
  });
});
