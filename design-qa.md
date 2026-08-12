# Design QA

- Source visual truth: `/Users/coreybaines/.t3/userdata/attachments/b51e2361-c6bd-4bb5-a3d9-72b5b171f07c-4e89e404-4909-4057-9e34-b6530ea46589.png`
- Source pixels: 3360 x 1940 at the supplied Retina density.
- Before implementation: `/Users/coreybaines/.t3/userdata/attachments/b51e2361-c6bd-4bb5-a3d9-72b5b171f07c-b8f74ff7-d389-450b-b680-d915305963b8.png`
- Before pixels: 3278 x 2030 at the supplied Retina density.
- Dropdown source crop: `/Users/coreybaines/.t3/userdata/attachments/b51e2361-c6bd-4bb5-a3d9-72b5b171f07c-bc145573-bd64-402a-87d6-17d1591e348c.png`
- Dropdown source pixels: 964 x 650 at the supplied Retina density.
- Dropdown before implementation: `/Users/coreybaines/.t3/userdata/attachments/b51e2361-c6bd-4bb5-a3d9-72b5b171f07c-6a3c5da8-e5a0-448d-a287-35a7a35ffd1b.png`
- Dropdown before pixels: 3272 x 2024 at the supplied Retina density.
- Target implementation: `apps/web/src/components/issues/NewIssueDialog.tsx`
- Target state: desktop new-issue modal, open with default properties and no attachments.
- Implementation screenshot: unavailable because repository instructions require explicit browser permission.

## Full-view comparison evidence

Both supplied images were opened at original resolution. The Pathway modal measured approximately
1456 x 540 CSS pixels at the captured density, while the Linear modal measured approximately
752 x 260 CSS pixels. The implementation could not be captured in a browser during this pass, so
no valid same-viewport combined comparison exists.

## Focused region comparison evidence

The supplied open-project states show matching popover widths of approximately 234–236 CSS pixels,
but the Pathway menu is approximately 168 CSS pixels tall against Linear's 139 CSS pixels. Source
inspection traced the extra 29 pixels to simultaneous shell padding and the shared viewport's
default 16-pixel inset. A post-fix browser capture is still unavailable.

## Required fidelity surfaces

- Fonts and typography: the title, description, breadcrumb, and property controls were reduced to
  the compact hierarchy visible in the Linear source, but not browser-compared.
- Spacing and layout rhythm: the desktop frame now targets 752 x 260 CSS pixels, with compressed
  header, editor, property, and footer spacing. Issue property popovers now use one 6-pixel inset
  instead of stacking shell padding over the shared 16-pixel viewport inset. The mobile sheet
  remains viewport-height.
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
- Focused lint, formatting, and web typecheck results are recorded in the pull request.

## Findings

- [P1] Browser-rendered fidelity and touch behavior are not yet proven.
  - Location: new-issue modal and its property popovers.
  - Evidence: source visual is available, but there is no implementation screenshot or touch run.
  - Impact: layout drift or a runtime-only interaction issue may remain despite source checks.
  - Fix: open the local Pathway preview with permission, exercise each picker and attachment path,
    capture the same 1526 x 538 state, and compare the two images together.

## Comparison history

- Initial pass: blocked before comparison because an implementation capture was not authorized.
- Fixes made from source inspection: reduced the desktop frame from 1472 x 544 to 752 x 260 CSS
  pixels; tightened typography, padding, property chips, attachment action, and primary action;
  retained the existing controlled popovers, coarse-pointer targets, and attachment flow.
- Dropdown-density pass: removed duplicate shell and viewport padding from the issue-composer
  property popovers while preserving 32-pixel option rows and 44-pixel coarse-pointer targets.
- Post-fix visual evidence: unavailable.

final result: blocked
