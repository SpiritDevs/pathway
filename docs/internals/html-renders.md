# HTML renders

An HTML render is a self-contained page an agent publishes into its thread with Pathway's
`html_render` MCP tool. The user-facing name is "visual reply" ([user docs](../user/html-renders.md)).
It is a port of T3 Code's inline HTML renders (#15968, with the #16196 bridge and the #16283 height
fix). `html_preview` is its companion: it renders a page in a headless browser and returns a
screenshot to the agent. Only compact metadata, not screenshot bytes, reaches the thread's work log.

Pages are for the user, so both tools belong only to threads the user reads directly.
`threadShowsHtmlRenders` (`apps/server/src/mcp/McpInvocationContext.ts`) excludes subagent threads
(`lineage.relationshipToParent === "subagent"`) and orchestrator workers (`orchestratorOrigin`).
`ProviderSessionManager` grants the `html` MCP capability only to the remaining threads, and
`McpHttpServer` lists the tools only for credentials holding it. The handler checks the live thread
shell as well, which covers a credential minted before the thread was re-parented. Forks keep the tools.

## Wire shape

The page is stored as a thread attachment (`createAttachmentId(threadId, "html")` + `.html`) with a
bootstrap injected into its head (`injectHtmlRenderBootstrap` in `packages/shared/src/htmlRender.ts`).
Local images are inlined at publish. The thread item carries only a reference
(`packages/contracts/src/htmlRender.ts`):

```json
{
  "type": "dynamic_tool",
  "toolName": "pathway.html_render",
  "status": "completed",
  "input": { "title": "Chart", "height": 480, "htmlBytes": 2400 },
  "output": {
    "htmlRender": {
      "attachmentId": "<thread-segment>-<uuid>-html",
      "title": "Chart",
      "height": 480,
      "heights": [
        [320, 620],
        [728, 480]
      ]
    },
    "message": "…"
  }
}
```

`heights` holds `[width, contentHeight]` pairs measured at publish across
`HTML_RENDER_MEASURE_WIDTHS`. It is absent when the environment has no usable Chromium.

Every adapter normalizes these items before they reach the projector (`compactHtmlToolProjection`
in `packages/shared/src/toolOutput.ts`). It sets `toolName` to `pathway.html_render` /
`pathway.html_preview`, drops raw `html` from the input, reduces publish output to exactly
`{ htmlRender, message }`, and keeps no screenshot bytes. Clients therefore read one shape and port no
provider envelope parser. `htmlRenderFromToolItem` selects a page only for a completed
`dynamic_tool` whose name resolves to `html_render`, without `isError`, and with a valid reference.
Running, failed, and malformed calls stay ordinary work rows.

## Serving

Clients sign the page through `assets.createUrl` with
`{ _tag: "attachment", attachmentId, fileName, mimeType: "text/html", disposition: "inline" }` and
resolve the relative URL against the owning environment's prepared HTTP base. That base is the
same for local, LAN, relay, and Pathway Connect connections, as for images and visualizations.
Inline `.html` responses carry `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and
`Cache-Control: private, max-age=3600`. They carry no `frame-ancestors` and no `X-Frame-Options`.
The signed token is the only credential, which an opaque-origin frame needs, since it cannot send
cookies.

Thread deletion removes the thread's pages: it collects references from the thread's own
`turnItems` and sweeps that thread's `*-html.html` files. Forks reference the source thread's
attachment, so deleting a fork leaves the source's pages in place.

## Web and desktop frame

`deriveTimelineEntriesFromVisibleTurnItems` (`apps/web/src/session-logic.ts`) emits an
`html-render` entry where the call happened. `timelineEntryIsPersistentResourceCard` treats it as a
persistent card. It joins its run's turn fold, so the fold row sits above it, but it is never hidden
by a turn fold or a superseded-attempt fold. `isRowUnchanged` compares references, so a tool update
elsewhere in the turn does not remount the frame.

`HtmlRenderFrame` (`apps/web/src/components/chat/HtmlRenderFrame.tsx`) reserves its box before the
page loads:

- **Width** comes from a ResizeObserver on the box.
- **Height** is `htmlRenderFrameHeight(reference, width, contentHeight)`. Before the page reports,
  the measured height at the nearest widths applies, so LegendList gets a stable first size. After
  load, `size-changed` messages fit the frame as the content changes. A frame shorter than its page would
  scroll and take the reader's wheel; a fitted page cannot scroll, so the wheel chains to the
  timeline. The agent's `height` caps the frame only when the page measured taller than it at the
  column width, or when the page was never measured. Heights clamp to 80–2000 before entering React
  state, so out-of-range height changes do not keep rendering the same maximum-size box. Intentionally
  capped pages still scroll inside the frame; this height rule does not override page-authored wheel
  or touch handlers.
- **URL.** The first successful signed URL is frozen for the frame's lifetime, because a new src
  would reload the page. Asset queries refresh every 30 minutes, and URLs within 60 seconds of
  expiry are refused, so a mount starts with a usable URL. A remount after virtualization
  reads the current one. A failed or unavailable URL shows "Unable to load" with a one-shot Retry.
  An iframe cannot report an HTTP failure, so a page whose request fails after signing shows the
  server's error body. **Reload page** remounts it with the current URL without leaving the thread.
  A later load also rotates to a newer signed URL if the asset query has refreshed, recovering a
  self-reload of a long-mounted page whose original URL expired. Query refresh alone never reloads
  a live page.

`HtmlRenderDocument` (`apps/web/src/components/chat/HtmlRenderDocument.tsx`) is the iframe:

- `sandbox="allow-scripts allow-forms"`. It never has `allow-same-origin`, so the page runs at an
  opaque origin outside the app's session and storage. It never has `allow-popups` either.
- `referrerPolicy="no-referrer"` and `loading="lazy"`. There is no `allow` attribute, so Permissions
  Policy denies camera, microphone, and similar features to the cross-origin frame.
- The theme from `useHtmlRenderTheme` goes on the first src as `#pathway-theme=<json>`. The
  bootstrap applies it before first paint and removes the fragment. Later changes, and one after
  each load, are posted as `host-context-changed`. The frame starts `scheme-light` and switches to
  the theme's color scheme after load, avoiding a white flash in dark mode.
- The `size-changed` listener is attached in a layout effect, so a fast page's first message is not
  missed.
- `ui/open-link` is honored only when `event.source` is this frame's window, the frame is
  `document.activeElement`, and `navigator.userActivation.isActive` is true. Missing activation
  information fails closed. The URL must be
  http(s). The link opens through `LocalApi.shell.openExternal`, which is `desktopBridge.openExternal`
  on desktop and a synchronous `window.open(…, "noopener,noreferrer")` on web. The host replies with
  `htmlRenderResult(id)`.

The full-size view is `HtmlRenderDialog`, opened from the frame's hover button through
`TimelineRowCtx.onHtmlRenderExpand` and rendered by `ChatView`. It is a Base UI dialog over the
window, following `ImageLightbox`. The page scrolls normally there, with no content fitting.
**Open in browser** opens the current signed URL with the theme fragment. The dialog hides the
desktop window buttons while open, as the lightbox does. The selected render is tied to its
environment and thread; switching threads closes the view without signing it against the new environment.

`useHtmlRenderTheme` maps the active palette, the same one `applyThemePalette` paints, through
`htmlRenderTheme`, with the user's sans and code fonts. The standard palettes live in
`packages/shared/src/themePalettes.ts`, so the injected default theme and the web app use one
source.

### Desktop

`makeDesktopContentSecurityPolicy` (`apps/desktop/src/electron/ElectronProtocol.ts`) allows
`frame-src 'self' http: https:`, mirroring `connect-src`, because environment origins are unknown
when the policy is built. Restricting frames to `backendOrigin` would break user-configured remote
environments; narrowing to their current origins requires updating the policy as connections change.
Script, worker, font, and form sources are unchanged. The iframe sandbox, not this policy, isolates the page. Link handling
needs no desktop change: the renderer goes through `desktopBridge.openExternal`, which accepts only
http(s). `setWindowOpenHandler` denies in-app windows. A sandboxed frame without
`allow-top-navigation` cannot navigate the app.

The `pathway://app` renderer is a secure context. Plain-http LAN framing depends on Chromium's
mixed-content policy and has not been verified in a real client. A blocked iframe is not necessarily
reported as an asset-signing failure. Pathway Connect uses https.

## Bridge

Pages and hosts speak a subset of the MCP Apps protocol (JSON-RPC 2.0 over `postMessage`):

| Direction   | Method                                  | Params                                                |
| ----------- | --------------------------------------- | ----------------------------------------------------- |
| host → page | `ui/notifications/host-context-changed` | `{ theme: "light" \| "dark", styles: { variables } }` |
| page → host | `ui/open-link` (request with `id`)      | `{ url }`; the host replies `{ result: {} }`          |
| page → host | `ui/notifications/size-changed`         | `{ height }`                                          |

There is no `ui/initialize`, no resources, and no tool calls from a page. A framed page posts its
links to the host. A top-level page (iOS full screen, a browser tab) marks http(s) links
`target=_blank`. Variable names (`--background`, `--foreground`, …, `--chart-1`…`--chart-6`, `--radius`,
`--font-sans`, `--font-mono`) are listed for agents in `HTML_RENDER_THEME_GUIDE`.

## iOS

`PathwayHTMLRender` reads the normalized reference, and `AgentHTMLRender.swift` shows it in a
`WKWebView` with a non-persistent data store. A top-level page has no parent frame, so its content
height reaches the app through a script message handler in a client content world that page
scripts cannot reach. Theme changes are posted into the page as `host-context-changed`. Links go
to the system browser only after a tap; hardware-keyboard activation is not supported by the tap
gate. The full screen view has a Done button and a 16 pt themed gutter. The web view exists only
while the row is visible and reloads when scrolled back into view. iOS has no custom themes, so pages
get the system palette. Non-2xx responses fail and retry once with a fresh URL before showing the
reload button.

The orchestrator conversation timeline (`components/orchestrator/conversationTimeline.ts`) still
shows delegated work cards. Its `OrchestratorWorkItem` contract has no HTML reference or tool output,
so displaying inline renders there needs a separate contract and server projection change.

## Performance

Each mounted row holds one live document running agent script. LegendList unmounts rows outside
its draw distance, and `loading="lazy"` defers frames near it. A remount reloads the page from the
HTTP cache. Nothing animates: the hover button's opacity transition runs only on hover, and
the bootstrap uses a ResizeObserver and load events, not a frame loop. Page bytes travel over
asset HTTP, never the websocket projection.

## Accepted risks

- **Focus.** A focused frame receives keystrokes, so Pathway's global keybindings and the dialog's
  Esc wait until the reader clicks back into the app. Focus moving into the frame also fires
  `blur` on the app window. This matches T3 and Pathway's email frames.
- **Network.** A page can load public resources, so opening it can reveal the reader's IP to
  those hosts. The `no-referrer` policy keeps the signed URL out of those requests.
- **Self-navigation.** A page can navigate its own frame, but it stays inside its opaque-origin
  box.

## Relation to visualizations

[Conversation visualizations](conversation-visualizations.md) (`visualize{…}` cards) link to a live
HTML file in the workspace and run it only when opened in a browser. HTML renders are stored
copies, themed and shown inline. Both remain available. Whether `visualize{}` becomes a legacy path
is a separate decision.
