export type SettingsPath =
  | "/settings/general"
  | "/settings/appearance"
  | "/settings/keybindings"
  | "/settings/projects"
  | "/settings/providers"
  | "/settings/scheduled-tasks"
  | "/settings/source-control"
  | "/settings/usage"
  | "/settings/issues-statuses"
  | "/settings/issues-labels"
  | "/settings/issues-intake"
  | "/settings/issues-import"
  | "/settings/issues-enrichment"
  | "/settings/email"
  | "/settings/connections"
  | "/settings/archived"
  | "/settings/diagnostics";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly to: SettingsPath;
  readonly targetId?: string;
}

/**
 * Section labels in sidebar order. The sidebar nav, the breadcrumb, and the
 * search-result subtitles all render from this record, so each label exists
 * once. `SETTINGS_NAV_GROUPS` slices the same paths into sidebar groups.
 */
export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, string>> = {
  "/settings/general": "General",
  "/settings/appearance": "Appearance",
  "/settings/keybindings": "Keybindings",
  "/settings/projects": "Projects",
  "/settings/providers": "Providers",
  "/settings/scheduled-tasks": "Schedule Tasks",
  "/settings/source-control": "Source Control",
  "/settings/usage": "Usage",
  "/settings/issues-statuses": "Statuses",
  "/settings/issues-labels": "Labels",
  "/settings/issues-intake": "Triage & Intake",
  "/settings/issues-import": "Import",
  "/settings/issues-enrichment": "Enrichment",
  "/settings/email": "Capture",
  "/settings/connections": "Connections",
  "/settings/archived": "Archive",
  "/settings/diagnostics": "Diagnostics",
};

export interface SettingsNavGroup {
  readonly label: string;
  readonly paths: ReadonlyArray<SettingsPath>;
}

/**
 * Sidebar grouping. Every `SettingsPath` belongs to exactly one group (asserted
 * in `settingsSearch.test.ts`); labels and icons stay keyed off the path.
 */
export const SETTINGS_NAV_GROUPS: ReadonlyArray<SettingsNavGroup> = [
  {
    label: "Workspace",
    paths: [
      "/settings/general",
      "/settings/appearance",
      "/settings/keybindings",
      "/settings/projects",
    ],
  },
  {
    label: "Agents",
    paths: [
      "/settings/providers",
      "/settings/scheduled-tasks",
      "/settings/source-control",
      "/settings/usage",
    ],
  },
  {
    label: "Issues",
    paths: [
      "/settings/issues-statuses",
      "/settings/issues-labels",
      "/settings/issues-intake",
      "/settings/issues-import",
      "/settings/issues-enrichment",
    ],
  },
  // Email is its own group rather than a System page: direct mailbox integration (Gmail, Outlook)
  // lands beside local capture later, and it is plainly not a System concern.
  {
    label: "Email",
    paths: ["/settings/email"],
  },
  {
    label: "System",
    paths: ["/settings/connections", "/settings/archived", "/settings/diagnostics"],
  },
];

/**
 * Every searchable setting, in result order. This catalog is the single
 * source of truth for anchor ids and visible titles: panels render both via
 * `searchableSetting`, so a retitle (or, later, a translation pass) happens
 * here once instead of separately in the panel and the index.
 */
export const SETTINGS_SEARCH_ITEMS = [
  {
    id: "color-scheme",
    title: "Color scheme",
    to: "/settings/appearance",
    // The scheme tiles sit at the top of the Appearance section.
    targetId: "appearance",
  },
  {
    id: "theme",
    title: "Themes",
    to: "/settings/appearance",
    // Theme cards live directly under the scheme tiles; the section is the
    // stable scroll destination for both.
    targetId: "appearance",
  },
  {
    // Prefixed because the slider control already owns the `glass-opacity` id.
    id: "setting-glass-opacity",
    title: "Glass opacity",
    to: "/settings/appearance",
  },
  {
    id: "environment-identification",
    title: "Environment identification",
    to: "/settings/appearance",
    // The setting is stage-dependent, so its parent section is the stable destination.
    targetId: "appearance",
  },
  {
    id: "interface-font",
    title: "Interface font",
    to: "/settings/appearance",
  },
  {
    id: "prompt-font",
    title: "Prompt font",
    to: "/settings/appearance",
  },
  {
    id: "code-font",
    title: "Code font",
    to: "/settings/appearance",
  },
  {
    id: "terminal-font",
    title: "Terminal font",
    to: "/settings/appearance",
  },
  {
    id: "font-smoothing",
    title: "Font smoothing",
    to: "/settings/appearance",
  },
  {
    id: "word-wrap",
    title: "Word wrap",
    to: "/settings/appearance",
  },
  {
    id: "composer-context",
    title: "Composer context",
    to: "/settings/appearance",
  },
  {
    id: "project-grouping",
    title: "Project grouping",
    to: "/settings/general",
  },
  {
    id: "auto-settle-inactive-threads",
    title: "Auto-settle inactive threads",
    to: "/settings/general",
  },
  {
    id: "time-format",
    title: "Time format",
    to: "/settings/general",
  },
  {
    id: "hide-whitespace-changes",
    title: "Hide whitespace changes",
    to: "/settings/general",
  },
  {
    id: "provider-update-checks",
    title: "Provider update checks",
    to: "/settings/general",
  },
  {
    id: "development-server-ports",
    title: "Development server ports",
    to: "/settings/general",
  },
  {
    id: "new-threads",
    title: "New threads",
    to: "/settings/general",
  },
  {
    id: "start-from-origin",
    title: "Start from origin",
    to: "/settings/general",
    targetId: "new-threads",
  },
  {
    id: "add-project-starts-in",
    title: "Add project starts in",
    to: "/settings/general",
  },
  {
    id: "archive-confirmation",
    title: "Archive confirmation",
    to: "/settings/general",
  },
  {
    id: "delete-confirmation",
    title: "Delete confirmation",
    to: "/settings/general",
  },
  {
    id: "text-generation-model",
    title: "Text generation model",
    to: "/settings/general",
  },
  {
    id: "diagnostics",
    title: "Diagnostics",
    to: "/settings/general",
  },
  {
    id: "legacy-plan-mode",
    title: "Plan mode (legacy)",
    to: "/settings/general",
  },
  {
    id: "legacy-token-streaming",
    title: "Stream token by token (legacy)",
    to: "/settings/general",
  },
  {
    id: "legacy-sidebar",
    title: "Sidebar (legacy)",
    to: "/settings/general",
  },
  {
    id: "keybindings",
    title: "Keybindings",
    to: "/settings/keybindings",
  },
  {
    id: "projects",
    title: "Projects",
    to: "/settings/projects",
  },
  // The settings themselves live on the per-project subpage, so the index section is the stable
  // destination: the search hit gets you to the project list, and you pick a project from there.
  {
    id: "project-default-model",
    title: "Project default model",
    to: "/settings/projects",
    targetId: "projects",
  },
  {
    id: "project-new-thread-workspace",
    title: "Project new-thread workspace",
    to: "/settings/projects",
    targetId: "projects",
  },
  {
    id: "project-scripts",
    title: "Project scripts",
    to: "/settings/projects",
    targetId: "projects",
  },
  {
    id: "project-checkouts",
    title: "Project checkouts",
    to: "/settings/projects",
    targetId: "projects",
  },
  {
    id: "providers",
    title: "Providers",
    to: "/settings/providers",
  },
  {
    id: "source-control",
    title: "Source control",
    to: "/settings/source-control",
  },
  {
    id: "issue-statuses",
    title: "Issue statuses",
    to: "/settings/issues-statuses",
  },
  {
    id: "issue-key-prefix",
    title: "Issue key prefix",
    to: "/settings/issues-statuses",
  },
  {
    id: "issue-labels",
    title: "Issue labels",
    to: "/settings/issues-labels",
  },
  {
    id: "issue-import",
    title: "Import issues",
    to: "/settings/issues-import",
  },
  {
    id: "issue-intake",
    title: "Slack intake",
    to: "/settings/issues-intake",
  },
  {
    id: "slack-bot-token",
    title: "Slack bot token",
    to: "/settings/issues-intake",
  },
  {
    id: "slack-watched-channels",
    title: "Watched Slack channels",
    to: "/settings/issues-intake",
  },
  {
    id: "issue-intake-automation",
    title: "Issue auto-assignment and audits",
    to: "/settings/issues-intake",
  },
  {
    id: "issue-enrichment",
    title: "Issue enrichment",
    to: "/settings/issues-enrichment",
  },
  {
    id: "issue-enrichment-model",
    title: "Investigation model",
    to: "/settings/issues-enrichment",
  },
  {
    id: "email-listener",
    title: "Local SMTP capture",
    to: "/settings/email",
  },
  {
    id: "email-listener-port",
    title: "Capture port",
    to: "/settings/email",
  },
  {
    id: "email-retention",
    title: "Captured mail retention",
    to: "/settings/email",
  },
  {
    id: "email-clear-all",
    title: "Clear captured mail",
    to: "/settings/email",
    // The row lives inside the retention section, which is the stable scroll target.
    targetId: "email-retention",
  },
  {
    id: "email-toasts",
    title: "Captured mail toasts",
    to: "/settings/email",
  },
  {
    id: "email-trigger-rules",
    title: "Mail trigger rules",
    to: "/settings/email",
  },
  {
    id: "remote-environments",
    title: "Remote environments",
    to: "/settings/connections",
  },
  {
    id: "archive",
    title: "Archived threads",
    to: "/settings/archived",
  },
  {
    id: "usage",
    title: "Usage analytics",
    to: "/settings/usage",
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export type SettingsSearchItemId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];

const SEARCH_ITEMS_BY_ID = Object.fromEntries(
  SETTINGS_SEARCH_ITEMS.map((item) => [item.id, item]),
) as Readonly<Record<SettingsSearchItemId, SettingsSearchItem>>;

/**
 * `id` and `title` props for the element a search item anchors to. Panels
 * spread (or pick from) this instead of restating the strings, so the catalog
 * and the rendered settings cannot drift apart.
 */
export function searchableSetting(id: SettingsSearchItemId): {
  readonly id: string;
  readonly title: string;
} {
  const { id: anchorId, title } = SEARCH_ITEMS_BY_ID[id];
  return { id: anchorId, title };
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];

  return items.filter((item) => normalizeSearchText(item.title).includes(normalizedQuery));
}
