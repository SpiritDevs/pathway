# Design QA

- Source visual truth: `/Users/coreybaines/.t3/userdata/attachments/b51e2361-c6bd-4bb5-a3d9-72b5b171f07c-e7d86a38-d025-40cc-858b-510d8e8a340c.png`
- Source pixels: 1526 x 538 at the supplied image density.
- Target implementation: `apps/web/src/components/issues/NewIssueDialog.tsx`
- Target state: desktop new-issue modal, open with default properties and no attachments.
- Intended viewport: 1526 x 538 CSS px at device scale factor 1.
- Implementation screenshot: unavailable because repository instructions require explicit browser permission.

## Full-view comparison evidence

The source image was opened at original resolution. The implementation could not be captured in a
browser during this pass, so no valid same-viewport combined comparison exists.

## Focused region comparison evidence

Blocked with the full-view comparison. The header, title and description fields, property chips,
attachment control, create-more switch, and primary action still need a browser-rendered comparison.

## Required fidelity surfaces

- Fonts and typography: implemented with Pathway's existing font tokens and a larger title/body
  hierarchy, but not visually compared.
- Spacing and layout rhythm: implemented as a wide 32 px-radius composer with spacious central
  fields and bottom-anchored properties, but not visually compared.
- Colors and visual tokens: kept on Pathway semantic background, border, muted, and primary tokens;
  no sampled browser comparison was possible.
- Image quality and asset fidelity: the reference contains UI icons only. The implementation uses
  the existing icon library and real image previews for attachments.
- Copy and content: matches the source's New issue, Issue title, Add description, Create more, and
  Create issue hierarchy while retaining Pathway-specific properties.

## Interaction verification

- Source-level verification covers controlled property popovers, native button options, file
  selection, paste, drag-and-drop, preview removal, upload, and attachment comment creation.
- Primary browser interactions tested: none; browser permission was not provided.
- Browser console errors checked: no.
- Focused unit tests, lint, formatting, and web/server/contracts typechecks pass.

## Findings

- [P1] Browser-rendered fidelity and touch behavior are not yet proven.
  - Location: new-issue modal and its property popovers.
  - Evidence: source visual is available, but there is no implementation screenshot or touch run.
  - Impact: layout drift or a runtime-only interaction issue may remain despite source checks.
  - Fix: open the local Pathway preview with permission, exercise each picker and attachment path,
    capture the same 1526 x 538 state, and compare the two images together.

## Comparison history

- Initial pass: blocked before comparison because an implementation capture was not authorized.
- Fixes made from source inspection: replaced menu radio groups in the modal with controlled
  popovers and native buttons; added coarse-pointer targets; added the Linear-shaped layout and
  complete attachment flow.
- Post-fix visual evidence: unavailable.

final result: blocked
