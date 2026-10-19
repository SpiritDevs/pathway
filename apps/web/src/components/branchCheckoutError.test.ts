import { describe, expect, it } from "vite-plus/test";
import { describeBranchCheckoutError } from "./branchCheckoutError";

describe("describeBranchCheckoutError", () => {
  it("recognizes a local-change conflict inside the server error wrapper", () => {
    const result = describeBranchCheckoutError(
      "Git command failed in GitVcsDriver.switchRef.checkout (/repo): git checkout failed: error: Your local changes to the following files would be overwritten by checkout:\n\tproject.pbxproj\nAborting",
    );
    expect(result.title).toBe("Local changes would be overwritten");
    expect(result.description).toContain("Commit or stash");
  });

  it("distinguishes untracked files from tracked changes", () => {
    expect(
      describeBranchCheckoutError(
        "error: The following untracked working tree files would be overwritten by checkout:",
      ).title,
    ).toBe("Untracked files would be overwritten");
  });

  it("does not misidentify other checkout failures as local changes", () => {
    expect(describeBranchCheckoutError("fatal: invalid reference: missing").title).toBe(
      "Couldn’t switch branches",
    );
  });
});
