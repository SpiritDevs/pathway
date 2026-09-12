# Conversation visualizations

Web/Electron and native Apple conversation Markdown recognize a standalone `visualize{"path":"/absolute/preview.html","title":"Optional title"}` paragraph as a visualization card. Paths are decoded as JSON, not Markdown URLs. Fenced and inline code remain literal. `mode` is accepted but does not affect the card; the browser provides the full viewing area.

The card uses its source thread and owning environment to request `assets.createUrl` with the `visualization-file` resource. Unlike workspace previews, these HTML files may live outside the project, including provider scratch directories. The authenticated RPC resolves the thread before signing access. The capability grants access to exactly one canonical HTML file and expires; it does not authorize sibling files. Ordinary workspace-file containment remains unchanged.

Web resolves the signed relative URL against the owning environment’s prepared HTTP connection. Electron opens that URL through `preview.open` in the same scoped thread; web opens a new browser tab. Native Apple requests a fresh signed URL on each open through its thread model’s environment. No client attempts to open a provider filesystem path locally.

Cards load asset metadata, not HTML or running iframes, into the timeline. HTML runs only when opened in the browser. HTML is served as authored; Codex-specific host globals and bundled styles are not provided. Files must remain on the environment; temporary-file persistence is separate from rendering support.

This is provider-independent Markdown handling; Codex, Claude, Cursor, Grok and OpenCode require no adapter changes. Direct, Connect and tunnel connections use the existing environment asset delivery. Web and Electron share the renderer; native Apple uses its own parser. There is no React Native or Android client in this checkout.
