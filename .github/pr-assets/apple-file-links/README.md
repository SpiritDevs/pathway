# Workspace file-link UI evidence

Captured on iPhone 17 Pro / iOS 26.3 on 20 September 2026 with a fixture conversation and environment file response. The production Markdown link handler and workspace file viewer are unchanged by the fixture setup.

- `before.png`: main at `3ee7aeb21`, after tapping the link. The conversation remains visible.
- `after.png`: the same link opens `report-a-bug.md` in the file viewer.
- `walkthrough.mp4`: tap the link, view the document, and return with Done.

Focused native UI tests passed on the before and after versions, checking the document text and return to the conversation. The temporary transport fixtures and capture tests are excluded from the PR. No live environment connection was used for this capture.
