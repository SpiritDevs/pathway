import { COMPANY_PERMISSIONS } from "@spiritdevs/contracts/company";
import { describe, expect, it } from "vite-plus/test";

import {
  PERMISSION_CATALOG,
  PERMISSION_GROUPS,
  permissionGroupSections,
  permissionPresentation,
} from "./permissionCatalog";

describe("permissionCatalog", () => {
  it("presents every contract permission exactly once", () => {
    const grouped = permissionGroupSections().flatMap((section) => section.permissions);
    expect([...grouped].sort()).toEqual([...COMPANY_PERMISSIONS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("keeps groups in catalog order and permissions in contract order", () => {
    const sections = permissionGroupSections();
    expect(sections.map((section) => section.group)).toEqual(
      PERMISSION_GROUPS.filter((group) =>
        COMPANY_PERMISSIONS.some((permission) => PERMISSION_CATALOG[permission].group === group),
      ),
    );
    const issues = sections.find((section) => section.group === "Issues");
    expect(issues?.permissions[0]).toBe("issues.read");
  });

  it("drops groups with no permissions in the given subset", () => {
    expect(permissionGroupSections(["calendar.read", "calendar.readAll"])).toEqual([
      { group: "Calendar", permissions: ["calendar.read", "calendar.readAll"] },
    ]);
  });

  it("labels the calendar switches and states that a grant is never sufficient", () => {
    const read = permissionPresentation("calendar.read");
    expect(read.group).toBe("Calendar");
    expect(read.label).toBe("Use the calendar");
    expect(read.description).toContain("a grant on its own is never enough");

    const readAll = permissionPresentation("calendar.readAll");
    expect(readAll.label).toBe("See every shared calendar");
    expect(readAll.description).toContain("without a named grant");
  });

  it("gives every permission a non-empty label and description", () => {
    for (const permission of COMPANY_PERMISSIONS) {
      const presentation = permissionPresentation(permission);
      expect(presentation.label.length).toBeGreaterThan(0);
      expect(presentation.description.endsWith(".")).toBe(true);
    }
  });
});
