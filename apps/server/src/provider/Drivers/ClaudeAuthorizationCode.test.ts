import { describe, expect, it } from "@effect/vitest";

import { parseClaudeAuthorizationCode } from "./ClaudeAuthorizationCode.ts";

describe("parseClaudeAuthorizationCode", () => {
  it("splits the code#state string the claude.com sign-in page hands out", () => {
    expect(parseClaudeAuthorizationCode("  abc123#oauth-state  ", "oauth-state")).toEqual({
      ok: true,
      code: "abc123",
    });
  });

  it("accepts a bare code", () => {
    expect(parseClaudeAuthorizationCode("abc123", "oauth-state")).toEqual({
      ok: true,
      code: "abc123",
    });
  });

  it("accepts a code with an empty state suffix", () => {
    expect(parseClaudeAuthorizationCode("abc123#", "oauth-state")).toEqual({
      ok: true,
      code: "abc123",
    });
  });

  it("rejects a code whose state belongs to another sign-in", () => {
    const result = parseClaudeAuthorizationCode("abc123#other-state", "oauth-state");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/different Claude sign-in/u);
    }
  });

  it("rejects an empty code before the separator", () => {
    const result = parseClaudeAuthorizationCode("#oauth-state", "oauth-state");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/full code was copied/u);
    }
  });

  it("rejects blank input", () => {
    const result = parseClaudeAuthorizationCode("   ", "oauth-state");
    expect(result.ok).toBe(false);
  });
});
