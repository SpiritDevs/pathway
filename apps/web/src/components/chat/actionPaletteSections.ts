import type { ActionPaletteSectionPreference } from "@t3tools/contracts";

export interface ActionPaletteSectionDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly defaultVisible: boolean;
  readonly defaultPosition: number;
}

/**
 * The action palette's registration point. Rendering, Settings, defaults, and
 * migration all resolve from this collection so a new section is declared once.
 */
export const ACTION_PALETTE_SECTION_DEFINITIONS = [
  {
    id: "workspace",
    label: "Workspace",
    description: "Environment, branch, and editor controls.",
    defaultVisible: true,
    defaultPosition: 0,
  },
  {
    id: "actions",
    label: "Actions",
    description: "Project scripts available in the current workspace.",
    defaultVisible: true,
    defaultPosition: 1,
  },
  {
    id: "usage",
    label: "Usage",
    description: "Provider limits and reset times.",
    defaultVisible: true,
    defaultPosition: 2,
  },
  {
    id: "development-environments",
    label: "Development environments",
    description: "Discovered local development servers.",
    defaultVisible: true,
    defaultPosition: 3,
  },
  {
    id: "terminals",
    label: "Terminals",
    description: "Active terminal sessions for the thread.",
    defaultVisible: true,
    defaultPosition: 4,
  },
  {
    id: "issues",
    label: "Issues",
    description: "Issues linked to the current thread.",
    defaultVisible: true,
    defaultPosition: 5,
  },
  {
    id: "version-control",
    label: "Version Control",
    description: "Branch, change, and repository actions.",
    defaultVisible: true,
    defaultPosition: 6,
  },
  {
    id: "automations",
    label: "Automations",
    description: "Scheduled tasks bound to the thread.",
    defaultVisible: true,
    defaultPosition: 7,
  },
  {
    id: "chats",
    label: "Chats",
    description: "Forks and side chats created from this thread.",
    defaultVisible: true,
    defaultPosition: 8,
  },
  {
    id: "lineage",
    label: "Lineage",
    description: "Parent, subagent, transfer, and fork relationships.",
    defaultVisible: true,
    defaultPosition: 9,
  },
] as const satisfies ReadonlyArray<ActionPaletteSectionDefinition>;

export type ActionPaletteSectionId = (typeof ACTION_PALETTE_SECTION_DEFINITIONS)[number]["id"];

export interface ResolvedActionPaletteSection extends ActionPaletteSectionDefinition {
  readonly id: ActionPaletteSectionId;
  readonly visible: boolean;
}

const DEFAULT_SECTIONS = [...ACTION_PALETTE_SECTION_DEFINITIONS].sort(
  (left, right) => left.defaultPosition - right.defaultPosition,
);
const DEFINITION_BY_ID = new Map(DEFAULT_SECTIONS.map((section) => [section.id, section]));

/**
 * Resolve persisted preferences against the current registry. Unknown and
 * duplicate ids are ignored. Newly registered sections are inserted beside
 * their default neighbours without discarding a user's existing reordering.
 */
export function resolveActionPaletteSections(
  preferences: ReadonlyArray<ActionPaletteSectionPreference>,
): ReadonlyArray<ResolvedActionPaletteSection> {
  const preferenceById = new Map<ActionPaletteSectionId, ActionPaletteSectionPreference>();
  const orderedIds: ActionPaletteSectionId[] = [];

  for (const preference of preferences) {
    if (!DEFINITION_BY_ID.has(preference.id as ActionPaletteSectionId)) continue;
    const id = preference.id as ActionPaletteSectionId;
    if (preferenceById.has(id)) continue;
    preferenceById.set(id, preference);
    orderedIds.push(id);
  }

  for (const definition of DEFAULT_SECTIONS) {
    if (preferenceById.has(definition.id)) continue;

    const laterDefault = DEFAULT_SECTIONS.find(
      (candidate) =>
        candidate.defaultPosition > definition.defaultPosition && orderedIds.includes(candidate.id),
    );
    if (laterDefault) {
      orderedIds.splice(orderedIds.indexOf(laterDefault.id), 0, definition.id);
      continue;
    }

    const earlierDefault = [...DEFAULT_SECTIONS]
      .reverse()
      .find(
        (candidate) =>
          candidate.defaultPosition < definition.defaultPosition &&
          orderedIds.includes(candidate.id),
      );
    if (earlierDefault) {
      orderedIds.splice(orderedIds.indexOf(earlierDefault.id) + 1, 0, definition.id);
    } else {
      orderedIds.push(definition.id);
    }
  }

  return orderedIds.map((id) => {
    const definition = DEFINITION_BY_ID.get(id)!;
    return {
      ...definition,
      visible: preferenceById.get(id)?.visible ?? definition.defaultVisible,
    };
  });
}

export function actionPalettePreferencesFromResolved(
  sections: ReadonlyArray<ResolvedActionPaletteSection>,
): ReadonlyArray<ActionPaletteSectionPreference> {
  return sections.map(({ id, visible }) => ({ id, visible }));
}

export function isDefaultActionPaletteConfiguration(
  sections: ReadonlyArray<ResolvedActionPaletteSection>,
): boolean {
  return sections.every(
    (section, index) =>
      section.id === DEFAULT_SECTIONS[index]?.id && section.visible === section.defaultVisible,
  );
}
