# Web bundle audit — October 2026

Follow-up to the [startup audit](startup-audit.md). Route splitting was already on, but the root route and the app shell still imported whole non-chat surfaces, Shiki, and Lucide's full icon map, and the entry was spread over ~180 files. This pass takes that code off the entry and ships the entry as three files.

## Measurements

Production `vp build` of the same tree, before and after. "Entry" is the module script plus every module preload in `dist/index.html`. "Route" adds the chunks the route's split component needs beyond the entry. Gzip is per file.

| Measurement                           | Before            | After             |
| ------------------------------------- | ----------------- | ----------------- |
| Entry JavaScript, raw / gzip          | 4,189 / 1,342 KiB | 3,181 / 983 KiB   |
| Entry JavaScript files                | 177               | 3                 |
| Modules bundled into the entry        | 1,910             | 1,609             |
| Entry + chat thread route, raw / gzip | 6,590 / 2,088 KiB | 5,937 / 1,857 KiB |
| Entry + Settings → General, gzip      | 1,656 KiB         | 1,378 KiB         |
| Entry + Calendar, gzip                | 1,342 KiB         | 1,017 KiB         |
| CSS (render-blocking), raw / gzip     | 489 / 64 KiB      | Unchanged         |

## What moved and why

| Change                                                                                                                                                                 | Where                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `validateSearch` imports its parser from the `.logic` module, not the page. Route options are never split, so importing from the page put the whole page in the entry. | `routes/calendar.tsx`, `routes/issues_.milestones.tsx`                     |
| Route-specific secondary sidebars and the orchestrator overlay are `React.lazy`, then warmed when the app goes idle. The thread sidebar stays eager.                   | `components/AppSidebarLayout.tsx`, `lib/whenIdle.ts`                       |
| Lucide's `DynamicIcon` (a name-to-import map of every icon) loads only when the palette shows a focus.                                                                 | `components/LucideNamedIcon.tsx`, `components/CommandPalette.tsx`          |
| Shiki loads on the first highlight rather than with the search dialog. `getFiletypeFromFileName` comes from its subpath.                                               | `lib/syntaxHighlighting.ts`, `components/search/HighlightedSearchLine.tsx` |
| Desktop-only hosts (browser webviews, preview automation, SnapShot) are lazy and gated on Electron, so the web client never downloads them.                            | `AppRoot.tsx`, `routes/__root.tsx`                                         |
| The landing route's chunks are requested when the router is created. TanStack otherwise waits for every `beforeLoad`, and the root's is the auth-gate round trip.      | `router.ts`                                                                |
| The entry's static dependency chain is emitted as `vendor` and `app` chunks (rolldown's `$initial` tag). Lazy chunks still split automatically.                        | `apps/web/vite.config.ts`                                                  |
| Hashed `/assets/*` are served `immutable`. Local, LAN, and tunnel browsers previously re-downloaded the bundle on every reload.                                        | `apps/server/src/http.ts`, `apps/web/vercel.ts`                            |

## Keeping the entry small

- Route options that run before render (`validateSearch`, `beforeLoad`) import only from `.logic` modules.
- Anything mounted from `__root.tsx` or `AppSidebarLayout.tsx` is on every route's critical path. A host that only matters on one surface, or only on desktop, belongs behind `React.lazy`.
- Heavy libraries used only after an interaction are imported at first use.

## Still on the chat path

- `DiffWorkerPoolProvider` wraps all of `ChatView`, and `@pierre/diffs/react`'s pool imports the Shiki highlighter. That puts about 75 KiB gzip of Shiki on the chat route. It cannot be deferred without remounting the chat tree. Hoisting the provider or making the pool lazy inside it would fix that.
- `CommandPalette` imports `CreateProjectDialog` and `ProjectContentSearchDialog`. `WorkspaceTopBar`'s account menu imports `ProviderUsage`. Each is 60–95 KiB pre-minify on every route.
- The chat route fans out into ~150 lazy chunks, mostly Lucide icons shared with other routes. They load in one parallel wave.

Not measured: packaged Electron launch, real remote latency, and time to first render in a browser.
