# Panes and windows

How the main window shows several rail pages side by side, and how a page opens in its own window. User-facing behaviour is in [Panels and windows](../user/panels-and-windows.md).

## One router per pane

A **pane** is one rail page with its own TanStack Router. The primary pane is the app router, which owns the URL. Every other pane gets a router over the same route tree with in-memory history (`apps/web/src/panes/paneRouters.ts`). Routes share one tree safely: `route.init` only assigns ids and paths.

Because each pane has a router, routed pages render in a pane unchanged: `useParams`, `useNavigate`, and `Link` inside a page already refer to that page's pane. The root route renders only `<Outlet/>` inside a side pane (`SidePaneContext` in `panes/paneScope.ts`), so the auth gate, app shell, and global hosts mount once.

## Chrome follows the focused pane

`AppSidebarLayout` renders the rail and top bar inside `RouterContextProvider` with the **focused pane's** router. Those components did not change: rail clicks and back and forward act on the focused pane because the router they read is that pane's. The command palette runs under the focused pane's router the same way. Until a newly focused side pane's router has loaded, the chrome stays on the app router, since match hooks throw against a router with no matches.

Each pane is its own `WorkspaceFrame`: the card with the page and its secondary sidebar, under its own `SidebarProvider`, so every pane's sidebar follows that pane's route and collapses on its own. `PaneRow` wraps the primary pane's frame back under the app router; a side pane's root route renders a frame around its outlet.

Anything window-global inside a pane must act only when its pane has focus: window keydown listeners (including the sidebars' shortcuts and the sidebar toggle), the preview and workspace-move buses, and the right-panel portal. `panes/usePaneFocus.ts` provides `usePaneId()` and `isPaneFocused()` for that; listeners check at event time so focus changes never re-render a page. Each pane frame has its own right-panel host, and a pane narrower than about 720 px shows the thread panel as a sheet.

## Layout

`panes/paneLayout.ts` is the pure model: an ordered list of panes, the focused pane, and a weight per pane. The number of visible panes follows from the row's width (360 px each); panes that do not fit collapse into edge tabs around the focused pane rather than closing. Closing the primary pane promotes its neighbour, whose location the app router then shows. `panes/paneStore.ts` persists the layout per device in localStorage.

`PaneRow` renders panes in a stable DOM order and places them with CSS `order`, so flipping or opening panes never remounts a page. New panes pop in with a one-shot CSS animation; displaced panes slide with one Web Animations transform. Both are off with reduced motion.

## Windows

A torn-out window is the same bundle in **window mode**: no rail, no split, and none of the alert hosts, which stay in the main window. The desktop shell loads `<app url>?pathwayWindow=<id>#<route>`; a web popup carries `pathway-window:<id>` in `window.name` (`panes/windowMode.ts`).

On desktop, the main process owns a registry of child windows (`apps/desktop/src/window/DesktopWindow.ts`, `DesktopChildWindows.ts`). It tracks each window's route from `did-navigate-in-page`, saves `{id, path, bounds}` next to the main window's bounds, and restores them at launch. The renderer reaches it through `desktopBridge.windows`. Each window is a separate renderer with its own WebSocket connection and state, so it costs more than a pane; opening past six windows shows a toast suggesting panes.

On web, `panes/pageWindows.ts` opens popups with `window.open`, and popups report their page and closing on a `BroadcastChannel`.

All entry points (rail menu and drag, pane pill, command palette, keybindings, desktop menus) go through `panes/paneActions.ts` and `panes/pageWindows.ts`.
