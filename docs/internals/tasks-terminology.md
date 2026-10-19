# Tasks terminology

The product name is **Tasks**, with **task** for one item and **subtask** for a child item. It describes planned work across professions without implying a defect. **Work items** is broader but less conversational; **To-dos** understates work that has its own status, assignee, history, and subtasks.

The distinction from **Scheduled tasks** remains explicit: those are recurring automations. Checklist items inside a task are lightweight steps, not independently tracked tasks.

## Surface audit

| Surface                    | Terminology covered                                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main navigation            | Expanded rail labels, collapsed tooltips, secondary sidebar, All tasks, My tasks, breadcrumbs, and back/forward history labels                                          |
| Task list and board        | Headers, counts and plural forms, creation actions, empty states, filters, bulk actions, and accessible names                                                           |
| Task details               | Create/edit/delete/restore, previous/next controls, copy/share actions, properties, subtasks, relations, attachments, and activity descriptions                         |
| Chat                       | Linked-task panel, command palette section, mention accessibility labels, pending task context, and discussion/start-work prompts                                       |
| Projects                   | Task summary tiles, connection hints, project moves/merges, deletion explanations, and company onboarding copy                                                          |
| Settings                   | Tasks group, searchable setting titles, statuses, labels, milestones, key prefix, import preview, enrichment, and role permissions                                      |
| Slack integrations         | Routing wizard, intake controls, task automation, activation errors, and agent investigation instructions                                                               |
| Calendar and time tracking | Task due-date layers, chart descriptions, task creation sessions, and analytics descriptions                                                                            |
| Agent tools                | MCP display titles and descriptions, attachment captions, discussion context, investigation output, and automation prompts                                              |
| Server and cloud           | Human-readable task errors, import reports, task creation descriptions, and default role descriptions                                                                   |
| Native Apple clients       | Shared navigation and dashboard, lists and boards, detail/creation/planning/settings screens, calendar/time screens, generated permission labels, and UI test selectors |
| Documentation              | User guides for tasks, Apple clients, calendar, time tracking, project connections, queued threads, and the contributor glossary                                        |

The web app supplies both hosted/local web and Electron's task interface. The separate desktop sources contain credential-issuance and diagnostic uses of “issue,” rather than an additional task interface. Native Apple screens are shared by iPhone and iPad; there are no Android application sources in this checkout. Keybinding configuration has no task-specific display label to rename; existing shortcuts retain their actions.

Codex, Claude, Cursor, Grok, and OpenCode retain their existing capabilities and adapters. This is a presentation change, so the shared task tools and prompts cover their supported paths without changing provider protocols. Delete/restore, parent/child navigation, and linked-task entry/return paths use the new wording together.

## Compatibility

Existing `/issues` and `/settings/issues-*` routes, `?issue=` links, storage keys, thread locations, RPC and sync operation names, permission keys, and `issues_*` MCP tool names remain stable. This preserves bookmarks, saved layouts, old conversations, and connections between different client/server versions. Local, remote, relay, and tunnel connections keep the same contracts and payloads.

CSV import accepts **Task ID**, **Task key**, and **Parent task**, as well as legacy issue headers. Title enrichment recognizes both **New task** and the legacy **New issue** placeholder.

Existing task titles, comments, saved view names, historical text, and custom role descriptions are not rewritten. References to external Sentry/GitHub issues, configuration problems, and issuing credentials retain their original meaning. Technical source names and historical implementation records may still use `Issue`.

## Verification

The audit used repository-wide searches plus syntax-aware inspection of TypeScript/JSX and Swift text, followed by a review of generated labels and the diff. Verification covered 52 focused test files (1,081 tests), scoped web/server/backend typechecks, lint on changed TypeScript files, formatting, and Swift syntax parsing. Existing lint warnings and Effect suggestions remain.

Browser and simulator UI verification was not run. Swift syntax parsing does not replace a native build or an integrated UI pass.
