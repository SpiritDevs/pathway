import { FocusId, FocusProjectKey, type Focus } from "@spiritdevs/contracts/focus";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFocusProjectOptions,
  focusOrderKeyForMove,
  projectFocusSelection,
} from "./FocusStrip.logic";

const WORK = FocusId.make("work");
const PERSONAL = FocusId.make("personal");
const STUDY = FocusId.make("study");

function focus(id: FocusId, orderKey: string): Focus {
  return {
    id,
    name: id,
    iconName: "Briefcase",
    accentColor: "#3b82f6",
    orderKey,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("Focus strip ordering", () => {
  it("creates a key between the moved Focus's new neighbors", () => {
    const focuses = [focus(WORK, "g"), focus(PERSONAL, "n"), focus(STUDY, "t")];
    const nextKey = focusOrderKeyForMove(focuses, STUDY, WORK);

    expect(nextKey).not.toBeNull();
    expect(nextKey! < "g").toBe(true);
  });

  it("does nothing for a drop on the same Focus", () => {
    expect(focusOrderKeyForMove([focus(WORK, "n")], WORK, WORK)).toBeNull();
  });
});

describe("project Focus selection", () => {
  const one = FocusProjectKey.make("environment-a:project-a");
  const two = FocusProjectKey.make("environment-b:project-b");

  it("recognizes one shared Focus across grouped checkouts", () => {
    expect(
      projectFocusSelection(
        [one, two],
        [
          { focusId: WORK, projectKey: one },
          { focusId: WORK, projectKey: two },
        ],
      ),
    ).toBe(WORK);
  });

  it("distinguishes unassigned and mixed groups", () => {
    expect(projectFocusSelection([one], [])).toBe("none");
    expect(
      projectFocusSelection(
        [one, two],
        [
          { focusId: WORK, projectKey: one },
          { focusId: PERSONAL, projectKey: two },
        ],
      ),
    ).toBe("mixed");
  });
});

describe("Focus editor project options", () => {
  it("shows one logical project for every grouped connection", () => {
    const options = buildFocusProjectOptions([
      {
        projectKey: "repository:quotecloud-v2",
        displayName: "quotecloud-v2",
        memberProjectRefs: [
          { environmentId: "studio", projectId: "quotecloud" },
          { environmentId: "studio-2", projectId: "quotecloud" },
          { environmentId: "laptop", projectId: "quotecloud" },
        ],
      },
    ]);

    expect(options).toEqual([
      {
        id: "repository:quotecloud-v2",
        name: "quotecloud-v2",
        projectKeys: ["studio:quotecloud", "studio-2:quotecloud", "laptop:quotecloud"],
      },
    ]);
  });
});
