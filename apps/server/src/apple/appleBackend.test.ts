import { describe, expect, it, vi } from "vite-plus/test";
import { ConvexError } from "convex/values";
import { makeXcodeAccountCheck } from "./appleBackend.ts";
const target = { companyId: "company", accountId: "account" };
describe("Xcode account custody checks", () => {
  it("checks environment custody without using a caller's permissions or Apple session expiry", async () => {
    const backend = { accountStatus: vi.fn(async () => ({ verifiedAt: null })) };
    expect(await makeXcodeAccountCheck(backend)(target)).toBe(true);
    expect(backend.accountStatus).toHaveBeenCalledExactlyOnceWith(target);
  });
  for (const code of [
    "entity-not-found",
    "company-not-found",
    "permission-denied",
    "environment-not-registered",
    "environment-key-mismatch",
  ]) {
    it(`recognizes the permanent Cloud custody denial ${code}`, async () => {
      const check = makeXcodeAccountCheck({
        accountStatus: async () => {
          throw new ConvexError({ code, message: "Denied" });
        },
      });
      expect(await check(target)).toBe(false);
    });
  }
  for (const error of [
    new Error("Cloud transport failed"),
    new ConvexError({ code: "not-authenticated", message: "Refresh credentials" }),
  ]) {
    it(`preserves jobs when custody cannot be verified: ${error instanceof ConvexError ? "authentication outage" : "network outage"}`, async () => {
      const check = makeXcodeAccountCheck({
        accountStatus: async () => {
          throw error;
        },
      });
      await expect(check(target)).rejects.toBe(error);
    });
  }
});
