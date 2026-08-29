import { FocusId, FocusProjectKey, type Focus } from "@spiritdevs/contracts/focus";
import { describe, expect, it } from "vite-plus/test";

import { groupProjectPickerEntriesByFocus } from "./DraftHeroHeadline.logic";

const WORK = FocusId.make("work");
const PERSONAL = FocusId.make("personal");

function focus(id: typeof WORK, name: string, orderKey: string): Focus {
  return {
    id,
    name,
    iconName: "Briefcase",
    accentColor: "#000000",
    orderKey,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("groupProjectPickerEntriesByFocus", () => {
  it("groups projects in Focus order and leaves unassigned projects last", () => {
    const work = { name: "Pathway", projectKeys: ["env:pathway"] };
    const personal = { name: "Site", projectKeys: ["env:site"] };
    const other = { name: "Scratch", projectKeys: ["env:scratch"] };

    const groups = groupProjectPickerEntriesByFocus({
      entries: [other, work, personal],
      focuses: [focus(PERSONAL, "Personal", "b"), focus(WORK, "Work", "a")],
      assignments: [
        { focusId: WORK, projectKey: FocusProjectKey.make("env:pathway") },
        { focusId: PERSONAL, projectKey: FocusProjectKey.make("env:site") },
      ],
    });

    expect(groups.map((group) => group.focus?.name ?? null)).toEqual(["Work", "Personal", null]);
    expect(groups.map((group) => group.entries.map((entry) => entry.name))).toEqual([
      ["Pathway"],
      ["Site"],
      ["Scratch"],
    ]);
  });

  it("does not put a logical project in a Focus when its checkouts disagree", () => {
    const mixed = { name: "Mixed", projectKeys: ["env-a:project", "env-b:project"] };
    const [group] = groupProjectPickerEntriesByFocus({
      entries: [mixed],
      focuses: [focus(WORK, "Work", "a"), focus(PERSONAL, "Personal", "b")],
      assignments: [
        { focusId: WORK, projectKey: FocusProjectKey.make("env-a:project") },
        { focusId: PERSONAL, projectKey: FocusProjectKey.make("env-b:project") },
      ],
    });

    expect(group?.focus).toBeNull();
    expect(group?.focusId).toBe("all");
    expect(group?.entries).toEqual([mixed]);
  });
});
