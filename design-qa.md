# Design QA

- Source visual truth: `/Users/coreybaines/.t3/userdata/attachments/e1b548f1-c4e6-437e-a465-5adae7d68ba7-4db4d414-54b3-408d-9cf6-6f6d737dcf25.png`, supplied for the pull-request search placement request.
- Implementation screenshot: unavailable; the attached collaborative preview reports as automation-capable, but navigation and snapshot capture failed.
- Viewport: implementation preview reports 1280 x 800 CSS px.
- Source pixels: 2084 x 724 px. Implementation pixels and density are unavailable, so density normalization could not be performed.
- State: desktop web, light mode, Dev artwork identification, `/pull-requests?involvement=all&state=open`, expanded Source Control sidebar.
- Requested outcome: replace the main-pane `Pull Requests` title with the functional search and filter controls and remove the duplicate search row below it.

## Full-view comparison evidence

Blocked. The source crop was opened and inspected, but the revised implementation could not be captured for a combined source-and-implementation comparison.

## Focused region comparison evidence

Blocked. Code inspection confirms that the existing `PullRequestSearchInput` and `PullRequestFiltersMenu` now render directly in the workspace top bar before the refresh and panel controls. The former breadcrumb title and in-flow duplicate control row are removed. A rendered top-bar crop is unavailable.

## Findings

- [P1] Post-fix visual confirmation is unavailable.
  - Location: Source Control main-pane top bar.
  - Evidence: collaborative preview navigation and snapshot calls failed after implementation.
  - Impact: search width, vertical centering, filter alignment, and coexistence with the right-side controls cannot be confirmed against the supplied source.
  - Fix: reconnect the collaborative preview and capture the Source Control view with the sidebar expanded and collapsed.

## Required fidelity surfaces

- Fonts and typography: the title is removed; the existing search placeholder and input typography are reused unchanged. Rendered baseline and antialiasing remain unverified.
- Spacing and layout rhythm: search and filter controls occupy the flexible top-bar region while refresh and panel controls remain right-aligned. The duplicate body row is removed. Rendered width and vertical alignment remain unverified.
- Colors and visual tokens: the existing input, filter, hover, focus, and active-filter tokens are unchanged. Rendered contrast remains unverified.
- Image quality and asset fidelity: no new image assets were introduced; existing Lucide search, filter, refresh, and panel icons are reused.
- Copy and content: the `Pull Requests` page title is removed from the main top bar; the accessible search and filter labels remain domain-specific.

## Primary interactions tested

- Contextual-sidebar and primary-navigation route resolution: 38 tests passed.
- Focused web typecheck, lint, formatting, and diff validation: passed.
- Mod/Ctrl+F now focuses and selects the persistent top-bar search input.
- Search typing, filter menu interaction, focus styling, sidebar collapse, and responsive layout: blocked by preview automation failure.
- Browser console errors: unavailable because the preview could not be inspected.

## Comparison history

1. The source crop identified the body search/filter row and the `Pull Requests` top-bar title.
2. The functional search and filter nodes were moved into the flexible top-bar region.
3. The breadcrumb title, scroll observer, compact duplicate filters, expandable duplicate search, and body control row were removed.
4. The keyboard search shortcut was simplified to target the single persistent input.
5. Post-fix capture failed before a visual comparison could be completed.

## Implementation checklist

- Reconnect the collaborative preview.
- Confirm the search replaces the title and fills the available top-bar width.
- Confirm the filter, refresh, and panel controls align vertically and remain clickable.
- Confirm Mod/Ctrl+F focuses the search.
- Confirm the body no longer renders a duplicate control row.
- Confirm expanded and collapsed sidebar layouts remain usable.

final result: blocked
