import { describe, expect, it } from "vite-plus/test";

import { formatWorkspaceRelativePath } from "./filePathDisplay";

describe("formatWorkspaceRelativePath", () => {
  it("formats absolute workspace paths from the workspace root", () => {
    expect(
      formatWorkspaceRelativePath(
        "C:/Users/mike/dev-stuff/pathway/apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/pathway",
      ),
    ).toBe("pathway/apps/web/src/session-logic.ts:501");
  });

  it("prefixes relative paths with the workspace root label", () => {
    expect(
      formatWorkspaceRelativePath(
        "apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/pathway",
      ),
    ).toBe("pathway/apps/web/src/session-logic.ts:501");
  });

  it("keeps paths already rooted at the workspace label stable", () => {
    expect(
      formatWorkspaceRelativePath(
        "pathway/apps/web/src/session-logic.ts:501",
        "C:/Users/mike/dev-stuff/pathway",
      ),
    ).toBe("pathway/apps/web/src/session-logic.ts:501");
  });

  it("preserves columns when present", () => {
    expect(
      formatWorkspaceRelativePath(
        "/C:/Users/mike/dev-stuff/pathway/apps/web/src/session-logic.ts:501:9",
        "C:/Users/mike/dev-stuff/pathway",
      ),
    ).toBe("pathway/apps/web/src/session-logic.ts:501:9");
  });
});
