import { CompanyId } from "@spiritdevs/contracts/company";
import { describe, expect, it } from "vite-plus/test";
import {
  defaultProjectOwner,
  PERSONAL_PROJECT_OWNER,
  projectOwnerOptions,
} from "./projectOwner.logic";

const personal = {
  id: CompanyId.make("personal"),
  name: "My workspace",
  workspaceKind: "personal" as const,
};
const company = {
  id: CompanyId.make("company"),
  name: "Company",
  workspaceKind: "organization" as const,
};

describe("project ownership choices", () => {
  it("puts personal first and defaults All companies to personal regardless of replica order", () => {
    expect(projectOwnerOptions([company, personal])).toEqual([personal, company]);
    expect(defaultProjectOwner([company, personal], null)).toBe(personal.id);
  });
  it("defaults a specific company filter to that company", () => {
    expect(defaultProjectOwner([personal, company], company.id)).toBe(company.id);
  });
  it("has no redundant choice for personal-only accounts", () => {
    expect(projectOwnerOptions([personal])).toEqual([personal]);
  });
  it("offers personal for organization-only accounts without assigning personal work to the company", () => {
    expect(defaultProjectOwner([company], null)).toBe(PERSONAL_PROJECT_OWNER);
    expect(projectOwnerOptions([company])).toHaveLength(2);
  });
  it("falls back to personal if a previous company is no longer available", () => {
    expect(defaultProjectOwner([personal], company.id)).toBe(personal.id);
  });
});
