import { describe, expect, it } from "vite-plus/test";

import { projectGroupTitleNeedsUpdate } from "./ProjectSettingsPanel.logic";

describe("projectGroupTitleNeedsUpdate", () => {
  it("updates divergent member titles even when the next title is the derived group label", () => {
    expect(
      projectGroupTitleNeedsUpdate(
        [{ title: "local-title" }, { title: "remote-title" }],
        "Repository name",
        true,
      ),
    ).toBe(true);
  });

  it("skips an untouched blur when the derived label differs from member titles", () => {
    expect(projectGroupTitleNeedsUpdate([{ title: "repo-slug" }], "Repository Name", false)).toBe(
      false,
    );
  });

  it("skips an update when every member already has the next title", () => {
    expect(
      projectGroupTitleNeedsUpdate(
        [
          { title: "Shared name", titleIsCustom: true },
          { title: "Shared name", titleIsCustom: true },
        ],
        "Shared name",
        true,
      ),
    ).toBe(false);
  });

  it("marks an unchanged automatic title as custom when explicitly entered", () => {
    expect(
      projectGroupTitleNeedsUpdate([{ title: "pathway", titleIsCustom: false }], "pathway", true),
    ).toBe(true);
  });

  it("updates members still using automatic titles after a partial rename", () => {
    expect(
      projectGroupTitleNeedsUpdate(
        [{ title: "pathway", titleIsCustom: true }, { title: "pathway" }],
        "pathway",
        true,
      ),
    ).toBe(true);
  });
});
