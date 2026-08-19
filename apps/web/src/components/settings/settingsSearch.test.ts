import { describe, expect, it } from "vite-plus/test";

import {
  searchableSetting,
  searchSettings,
  SETTINGS_NAV_GROUPS,
  SETTINGS_SEARCH_ITEMS,
  SETTINGS_SECTION_LABELS,
  settingsLocationIsVisibleForWorkspace,
  settingsPathIsVisibleForWorkspace,
  settingsSectionPathForLocation,
  type SettingsSearchItem,
} from "./settingsSearch";

const ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "word-wrap",
    title: "Word wrap",
    to: "/settings/general",
  },
  {
    id: "network-access",
    title: "Network access",
    to: "/settings/environments",
  },
  {
    id: "providers",
    title: "Providers",
    to: "/settings/providers",
  },
  {
    id: "provider-updates",
    title: "Update checks",
    to: "/settings/general",
  },
  {
    id: "automatic-updates",
    title: "Automatic updates",
    to: "/settings/general",
  },
];

describe("searchSettings", () => {
  it("matches only setting titles", () => {
    expect(searchSettings("word", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("network", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("connections", ITEMS)).toEqual([]);
    expect(searchSettings("claude", ITEMS)).toEqual([]);
  });

  it("matches normalized title substrings", () => {
    expect(searchSettings("  WORD   WRAP  ", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("glass").map((item) => item.id)).toEqual(["setting-glass-opacity"]);
    expect(searchSettings("xyzzy")).toEqual([]);
  });

  it("finds the development server port range", () => {
    expect(searchSettings("development server ports")).toEqual([
      {
        id: "development-server-ports",
        title: "Development server ports",
        to: "/settings/general",
      },
    ]);
  });

  it("finds the queue or steer preference", () => {
    expect(searchSettings("queue or steer")).toEqual([
      {
        id: "active-turn-send-action",
        title: "Queue or steer messages",
        to: "/settings/general",
      },
    ]);
  });

  it("keeps catalog order for multiple title matches", () => {
    expect(searchSettings("update", ITEMS).map((item) => item.id)).toEqual([
      "provider-updates",
      "automatic-updates",
    ]);
  });

  it("returns no results for an empty query", () => {
    expect(searchSettings("   ", ITEMS)).toEqual([]);
  });

  it("keeps catalog result ids unique", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("serves anchor props to panels from the catalog", () => {
    expect(searchableSetting("word-wrap")).toEqual({ id: "word-wrap", title: "Word wrap" });
    expect(searchableSetting("archive")).toEqual({ id: "archive", title: "Archived threads" });
  });

  it("routes appearance settings to their current section", () => {
    expect(searchSettings("theme")[0]).toMatchObject({
      id: "theme",
      to: "/settings/appearance",
    });
    expect(searchSettings("word wrap")[0]).toMatchObject({
      id: "word-wrap",
      to: "/settings/appearance",
    });
    expect(searchSettings("composer context")[0]).toMatchObject({
      id: "composer-context",
      to: "/settings/appearance",
    });
    expect(searchSettings("environment identification")[0]).toMatchObject({
      id: "environment-identification",
      to: "/settings/appearance",
      targetId: "appearance",
    });
    expect(searchSettings("action palette")[0]).toMatchObject({
      id: "action-palette",
      to: "/settings/appearance/action-palette",
    });
  });

  it("routes usage analytics to its Settings section", () => {
    expect(searchSettings("usage analytics")[0]).toMatchObject({
      id: "usage",
      to: "/settings/usage",
    });
  });

  it("routes issue settings to their Settings sections", () => {
    expect(searchSettings("issue statuses")[0]).toMatchObject({
      id: "issue-statuses",
      to: "/settings/issues-statuses",
    });
    expect(searchSettings("issue labels")[0]).toMatchObject({
      id: "issue-labels",
      to: "/settings/issues-labels",
    });
    expect(searchSettings("issue milestones")[0]).toMatchObject({
      id: "issue-milestones",
      to: "/settings/issues-milestones",
    });
    expect(searchSettings("import issues")[0]).toMatchObject({
      id: "issue-import",
      to: "/settings/issues-import",
    });
  });
});

describe("SETTINGS_NAV_GROUPS", () => {
  const groupedPaths = SETTINGS_NAV_GROUPS.flatMap((group) => group.paths);

  it("places every settings section in exactly one group", () => {
    expect([...groupedPaths].sort()).toEqual(Object.keys(SETTINGS_SECTION_LABELS).sort());
  });

  it("keeps the record in sidebar order", () => {
    expect(groupedPaths).toEqual(Object.keys(SETTINGS_SECTION_LABELS));
  });

  it("groups the tracker pages under Issues", () => {
    expect(SETTINGS_NAV_GROUPS.map((group) => group.label)).toEqual([
      "Workspace",
      "Account",
      "Agents",
      "Issues",
      "Email",
      "System",
    ]);
    expect(SETTINGS_NAV_GROUPS.find((group) => group.label === "Issues")?.paths).toEqual([
      "/settings/issues-statuses",
      "/settings/issues-labels",
      "/settings/issues-milestones",
      "/settings/issues-import",
      "/settings/issues-enrichment",
      "/settings/integrations",
    ]);
  });

  it("puts collaboration and environments in the Account group", () => {
    expect(SETTINGS_NAV_GROUPS.find((group) => group.label === "Account")?.paths).toEqual([
      "/settings/members-teams",
      "/settings/company-members",
      "/settings/company-teams",
      "/settings/company-roles",
      "/settings/environments",
    ]);
    expect(searchSettings("members and invitations")[0]).toMatchObject({
      id: "company-members",
      to: "/settings/company-members",
    });
    expect(searchSettings("teams")[0]).toMatchObject({
      id: "company-teams",
      to: "/settings/company-teams",
    });
    expect(searchSettings("roles and permissions")[0]).toMatchObject({
      id: "company-roles",
      to: "/settings/company-roles",
    });
    expect(searchSettings("upgrade to a company workspace")[0]).toMatchObject({
      id: "company-upgrade",
      to: "/settings/members-teams",
    });
    expect(searchSettings("workspace sync status")[0]).toMatchObject({
      id: "company-sync",
      to: "/settings/diagnostics",
    });
    expect(searchSettings("workspace environments")[0]).toMatchObject({
      id: "company-environments",
      to: "/settings/environments",
    });
    expect(searchSettings("Slack bot token")[0]).toMatchObject({
      id: "slack-bot-token",
      to: "/settings/integrations",
      targetId: "issue-intake",
    });
    expect(searchSettings("add environment")[0]).toMatchObject({
      id: "add-environment",
      to: "/settings/environments",
      targetId: "company-environments",
    });
  });

  it("shows split administration pages only for organization workspaces", () => {
    expect(settingsPathIsVisibleForWorkspace("/settings/members-teams", "personal")).toBe(true);
    expect(settingsPathIsVisibleForWorkspace("/settings/company-members", "personal")).toBe(false);
    expect(settingsPathIsVisibleForWorkspace("/settings/members-teams", "organization")).toBe(
      false,
    );
    expect(settingsPathIsVisibleForWorkspace("/settings/company-members", "organization")).toBe(
      true,
    );
    expect(settingsPathIsVisibleForWorkspace("/settings/company-teams", "organization")).toBe(true);
    expect(settingsPathIsVisibleForWorkspace("/settings/company-roles", "organization")).toBe(true);
  });

  it("keeps app and personal settings visible in the profile scope", () => {
    expect(settingsPathIsVisibleForWorkspace("/settings/general", "profile")).toBe(true);
    expect(settingsPathIsVisibleForWorkspace("/settings/providers", "profile")).toBe(true);
    expect(settingsPathIsVisibleForWorkspace("/settings/company-members", "profile")).toBe(false);
    expect(settingsPathIsVisibleForWorkspace("/settings/environments", "profile")).toBe(true);
    expect(settingsPathIsVisibleForWorkspace("/settings/integrations", "profile")).toBe(true);
    expect(settingsPathIsVisibleForWorkspace("/settings/issues-statuses", "profile")).toBe(true);
    expect(settingsPathIsVisibleForWorkspace("/settings/email", "profile")).toBe(true);
  });

  it("resolves direct and nested Settings locations to their owning section", () => {
    expect(settingsSectionPathForLocation("/settings/company-members")).toBe(
      "/settings/company-members",
    );
    expect(settingsSectionPathForLocation("/settings/projects/pathway")).toBe("/settings/projects");
    expect(settingsSectionPathForLocation("/settings/appearance/action-palette")).toBe(
      "/settings/appearance",
    );
    expect(settingsSectionPathForLocation("/settings")).toBeNull();
  });

  it("rejects direct company-owned Settings locations in Profile scope", () => {
    expect(settingsLocationIsVisibleForWorkspace("/settings/company-members", "profile")).toBe(
      false,
    );
    expect(settingsLocationIsVisibleForWorkspace("/settings/integrations", "profile")).toBe(true);
    expect(settingsLocationIsVisibleForWorkspace("/settings/projects/pathway", "profile")).toBe(
      true,
    );
  });

  it("keeps Projects in the Workspace group with its own settings page", () => {
    expect(SETTINGS_NAV_GROUPS.find((group) => group.label === "Workspace")?.paths).toEqual([
      "/settings/general",
      "/settings/appearance",
      "/settings/keybindings",
      "/settings/projects",
    ]);
    expect(searchSettings("projects")[0]).toMatchObject({
      id: "projects",
      to: "/settings/projects",
    });
    // The per-project settings live on the subpage, so their search hits land on the index section.
    expect(searchSettings("project scripts")[0]).toMatchObject({
      id: "project-scripts",
      to: "/settings/projects",
      targetId: "projects",
    });
  });

  it("gives capture its own group, so mailbox integrations have a home to land in", () => {
    expect(SETTINGS_NAV_GROUPS.find((group) => group.label === "Email")?.paths).toEqual([
      "/settings/email",
    ]);
    expect(searchSettings("capture port")[0]).toMatchObject({
      id: "email-listener-port",
      to: "/settings/email",
    });
    expect(searchSettings("trigger rules")[0]).toMatchObject({
      id: "email-trigger-rules",
      to: "/settings/email",
    });
  });

  it("lands per-project capture settings on the section that holds them", () => {
    expect(searchSettings("project capture addresses")[0]).toMatchObject({
      id: "email-project-capture",
      to: "/settings/email",
    });
    // Both are edited inside a project's collapsed block, so the section is the scroll target.
    expect(searchSettings("mail slug")[0]).toMatchObject({
      id: "email-mail-slug",
      to: "/settings/email",
      targetId: "email-project-capture",
    });
    expect(searchSettings("capture password")[0]).toMatchObject({
      id: "email-capture-password",
      to: "/settings/email",
      targetId: "email-project-capture",
    });
  });
});
