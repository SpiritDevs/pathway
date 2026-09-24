import {
  AuthAccessWriteScope,
  AuthComputerOperateScope,
  AuthOrchestrationOperateScope,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sessionCanUseComputer } from "./computerAccess";

const operator = { authenticated: true, scopes: [AuthOrchestrationOperateScope] };
const computerOperator = {
  authenticated: true,
  scopes: [AuthOrchestrationOperateScope, AuthComputerOperateScope],
};
const admin = {
  authenticated: true,
  scopes: [AuthOrchestrationOperateScope, AuthAccessWriteScope],
};

describe("sessionCanUseComputer", () => {
  it("holds a session to the environment's access policy", () => {
    expect(sessionCanUseComputer("scoped", operator)).toBe(false);
    expect(sessionCanUseComputer("scoped", computerOperator)).toBe(true);
    expect(sessionCanUseComputer("scoped", admin)).toBe(true);

    // Any operator admits a plain pairing; admins-only refuses `computer:operate`.
    expect(sessionCanUseComputer("any-operator", operator)).toBe(true);
    expect(sessionCanUseComputer("admins-only", computerOperator)).toBe(false);
    expect(sessionCanUseComputer("admins-only", admin)).toBe(true);
  });

  it("never blames the pairing without evidence", () => {
    expect(sessionCanUseComputer("admins-only", { authenticated: true })).toBe(true);
    expect(sessionCanUseComputer("admins-only", { authenticated: false, scopes: [] })).toBe(true);
    expect(sessionCanUseComputer("admins-only", null)).toBe(true);
  });
});
