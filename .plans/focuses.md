# Focuses — implementation spec

Status: design confirmed by Corey 2026-08-28 (grilling session). Canonical vocabulary in
`docs/internals/glossary.md` (Focus, All Focus, Active Focus, Focus Strip, Focus Assignment,
Focus Creator, Notification Tray, Attention Event). Decisions recorded in
`docs/adr/0001-focus-is-an-agent-threads-filter.md`, `0002-focus-definitions-sync-selection-is-local.md`,
`0003-focus-notifications-are-a-persisted-log.md`. Read all four before writing code.

## Product summary

A **Focus** is a named, user-defined set of projects (e.g. Work, Personal) that filters the
Agent Threads sidebar only. Key rules:

- A **Focus Strip** is fixed to the bottom of the Agent Threads sidebar (`apps/web/src/components/Sidebar.tsx`),
  only in that view. Left→right: **All** tab (always first, undeletable, = today's unfiltered view),
  user Focuses as small Lucide icons with accent colors (shrink toward dots, dock-style magnify on
  hover), then on the right a notification badge and a "+" creator button.
- **Focus Assignment is exclusive**: a project belongs to 0 or 1 Focus. Unassigned projects appear
  only under All. Assigning a project already in another Focus *moves* it (show a "moving from X" hint).
- A Focus is a **filter, not a container**: pinned/snoozed/active/settled remain thread-level states;
  the active Focus just filters every section, the project dropdown, and which threads are shown.
- The app-wide **company scope** composes upstream and independently: a Focus tab with zero visible
  projects under the current company scope is hidden. If the active Focus becomes hidden or is
  deleted, silently fall back to All.
- **Search is global regardless of active Focus**: results grouped under Focus headers (active Focus's
  group first, then other Focuses, unassigned last under All). Clicking a result switches the active
  Focus to that thread's Focus and opens the thread.
- **Sync split (ADR 0002)**: Focus definitions (name, Lucide icon name, accent color, order,
  project assignments) live in Convex and sync across machines. The *active Focus selection* is
  per-machine localStorage, modeled on `activeCompanyIdAtom` (`apps/web/src/cloud/activeCompany.ts`).
- **Notifications (ADR 0003)**: an **Attention Event** = run finished on an unsettled thread,
  pending approval, awaiting user input, or failure. Each writes a persisted notification record to
  Convex. Badge = total unread count; opening the Notification Tray marks all read via a Convex
  watermark (clears on every machine). Retention deletes records: read + 7 days, unread + 30 days,
  hard cap 200 per user (oldest evicted). Reading never deletes early.
- **Creator/editor**: "+" opens a corner popup anchored above the strip: name, curated Lucide icon
  picker (~30–40 glyphs), accent color swatches, exclusive project tick-list. Right-click a Focus tab →
  same popup + Delete. Deleting a Focus only unlinks (projects → unassigned; threads untouched).
- Also in v1: drag-reorder of Focus tabs (order synced with definitions), command-palette
  "Switch Focus…" actions, a cycle-Focus keybinding, and a per-project "Focus: ▾" quick-assign in the
  existing project dropdown/settings menu.
- v1 surfaces: web + desktop. Mobile later (reads the same Convex data; don't block on it).

## Codebase map (verified 2026-08-28)

- Sidebar: `apps/web/src/components/Sidebar.tsx` (search input ~L3576; "All projects" dropdown
  L3669–3752; section render loop L3845–4150; row components earlier in file). Pure logic:
  `apps/web/src/components/Sidebar.logic.ts` (`filterSidebarV2VisibleThreads` L115,
  `searchSidebarThreadsByTitle` L621, status pills L161–184, `hasUnseenCompletion` L308).
- Project filter state: `projectScopeKey` local state `Sidebar.tsx:2059`; scoped keys are
  `` `${environmentId}:${projectId}` `` sets; `null` = all.
- Project list source: `useWorkspaceProjects()` → `useProjectGroups()` →
  `packages/client-runtime/src/state/projectGrouping.ts`.
- Company scoping precedent: `apps/web/src/cloud/activeCompany.ts` (atoms + localStorage),
  applied in `apps/web/src/cloud/agentThreadReadModel.ts` and `apps/web/src/state/threads.ts:23–34`.
- Client settings: `packages/contracts/src/settings.ts` (`ClientSettingsSchema`),
  hook `apps/web/src/hooks/useSettings.ts`. Local UI state: `apps/web/src/uiStateStore.ts`.
- Convex backend: `packages/backend/convex/schema.ts` (see `companies`, `memberships`,
  `cloudProjects` L394, `agentThreads` L903, relay tables L984–1130 for conventions).
- Wire contracts live in `packages/contracts/src/` (e.g. `orchestrationV2.ts`, `company.ts`,
  `cloudProject.ts`). Every wire-crossing type goes here — repo rule.
- Server (environment) side: `apps/server/src/orchestration-v2/Orchestrator.ts`,
  `ProjectionMaintenance.ts`; existing push-to-Convex precedent for agent activity is the relay
  tables (`relayAgentActivityRows` etc.).
- Icon pack: `lucide-react` (already a dependency of `apps/web`).
- Tabs/popover primitives: `apps/web/src/components/ui/` (no generic tabs.tsx; there are
  toggle-group, popover-style menus — follow existing shadcn-ish idioms).
- Command palette: `apps/web/src/components/CommandPalette.tsx` + `.logic.ts` (company switcher at
  ~L698 is the precedent for Focus switcher actions).

## Conventions

- pnpm monorepo; verify with `pnpm typecheck` (alias `pnpm tc`), `pnpm lint`, `pnpm test` (scope with
  vp filters where possible). Effect/Schema for contracts; @effect/atom-react atoms for shared state.
- "Reverse states": every way in needs a way out.
- Match surrounding code style; no stray comments explaining changes.
- User-facing docs for the feature belong in `docs/user/` (final phase).

## Phases

1. **Foundation**: Convex schema + functions (focuses, assignments, notifications, read watermark,
   retention cron) + wire contracts + client-runtime read model (focus atoms, active-focus
   localStorage atom, scoping helpers).
2. **Sidebar UI**: Focus Strip, Focus Creator popup, sidebar scoping (sections, project dropdown,
   search grouping), quick-assign in project menu.
3. **Notifications**: attention-event writer (server → Convex), Notification Tray UI + badge.
4. **Polish**: command palette + keybinding, cross-machine fallback edge cases, docs/user page,
   full typecheck/lint/test pass.

Each phase is audited before the next begins.
