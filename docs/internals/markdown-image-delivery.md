# Conversation Markdown image delivery

`ChatMarkdownImage` classifies image destinations separately from editor links. Editor line suffixes and the client's operating system do not participate in filesystem resolution. Known filesystem roots, descendants of the supplied workspace, drive paths, and `file:` URLs identify workspace resources. Other root-relative URLs keep their web meaning. Unsupported schemes produce an unavailable state.

The renderer requests `assets.createUrl` with `workspace-file`, the message's owning thread ID, and the original decoded path. `useAssetUrlState` scopes its query and prepared HTTP connection to the owning environment ID. Inherited timeline items use their source thread ID. No active-environment selection participates in delivery.

The server selects the thread's worktree, project workspace, or conversation directory. Existing canonical-path, traversal, symlink, preview-type, expiry, and signature validation remains authoritative. Image claims authorize exactly one file. Filesystem names are encoded before preview-extension inspection so literal URL delimiters cannot change classification.

URLs remain transient view state. Web consumers share the existing asset query family, generation-based reconnect invalidation, refresh schedule, and immediate disposal when unused. Expired results and load errors permit a bounded refresh. Streaming retains a stable image renderer. Copying rendered Markdown restores the original destination instead of copying the signed capability.

Native `AgentTranscriptMarkdown` passes optional model/thread context to `PathwayIssueMarkdownView`. Inline images use `AgentMarkdownImage`, the owning model's environment-aware HTTP support, cancellation checks, and the existing attachment preview. Reopen, reconnect, foreground, and explicit retry obtain fresh access. Image loading has no polling or animated spinner. Shared SwiftUI sizing supports iPhone, iPad, and the shared Apple layouts. Markdown consumers without resource context retain their previous native text behavior.

## Coverage

| Area                                   | Decision                                                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Assistant and historical messages      | Resolve through their owning environment and source thread.                                                                   |
| Tool activity and reasoning            | Markdown presentations receive the same context; plain structured/raw output stays text.                                      |
| Web and Electron                       | Share `ChatMarkdown`; no Electron filesystem dependency.                                                                      |
| Native Apple                           | Shared conversation Markdown supports inline and HTTPS-linked images; reference-style image definitions remain a limitation.  |
| Codex, Claude, Cursor, Grok, OpenCode  | Provider-independent Markdown handling. No adapter changes or invented `sandbox:` mappings.                                   |
| Contracts                              | Existing workspace-file asset resource and signed URL result; no wire changes.                                                |
| Direct, Connect, tunnel                | Use the prepared connection's HTTP base. Each delivery mode still needs end-to-end verification in its configured deployment. |
| Issue descriptions and other consumers | No new native image behavior without context; web local images without context show an unavailable state.                     |

An image path does not create a durable attachment. Existing uploads persist attachment IDs, but there is no general flow that ingests an arbitrary provider-local path. Any future temporary-file ingestion needs a separate authorized copy/persistence design.
