# Design QA

- Source visual truth: the supplied 630 x 1050 px environment-card reference and 2352 x 1920 px Pathway toolbar screenshot.
- Target state: desktop thread header with consolidated environment actions.
- Responsive behavior: compact headers disclose the card from the Commit & push chevron; sufficiently wide header containers keep the card visible and hide that chevron.

## Implementation evidence

- Removed the standalone Add action and Open control groups from the thread header.
- Added source-control actions directly beneath the Environment branch summary, followed by distinct Actions and Editor sections.
- Grouped project scripts and Add action under the new Actions heading.
- Reduced Editor to the preferred editor by default, with an animated disclosure for the remaining installed editors and file manager.
- Kept Commit & push as the immediate toolbar action.
- The card closes on outside interaction or Escape and uses a short transform-and-opacity entrance.
- The persistent state is driven by the named header container and is suppressed when the right panel already consumes the available width.
- The dropdown trigger remains visible in the persistent wide layout and can dismiss or reopen the card.
- The wide trigger explicitly restores its outer end border and corner after the compact trigger is hidden.
- The compact trigger likewise preserves its outer end border even though the alternate wide trigger follows it in the DOM.
- The tablet right-panel sheet now matches the fixed panel's 540 px default width, workspace-row insets, rounded border, and card shadow.
- Its top edge starts directly below the workspace bar, without the extra 8 px inset that made it shorter than the other workspace cards.
- The floating viewport uses the workspace shell's actual 44 px top bar height rather than the inner content header's 52 px token.
- The floating panel now shares the fixed panel's persisted width and left-edge resize handle, with the same 360 px minimum.
- Its tablet maximum now follows the live navigation rail edge instead of the fixed panel's 70% cap, including while the rail expands or collapses.
- The former maximize action now pops the inline panel into that same floating, resizable tablet sheet instead of replacing the chat column; the sheet exposes a Dock panel reverse action.
- That desktop-only Dock panel action is rendered directly in the popped-out sheet header; responsive tablet and smaller sheets retain their existing header controls without the dock action.
- Source Control pull-request details now use the same inline, explicit desktop pop-out, dock-back, and automatic smaller-tablet sheet model, while retaining their own persisted panel width.
- The closed Source Control panel toggle now uses the same shared titlebar-control inset and vertical centering as the sheet header, while the search row reserves its footprint.
- Panel layout controls now retain the same 52 px titlebar centering and one-pixel optical end inset in closed, fixed, and floating states.
- The floating shell now clips its square panel child to the same rounded corners and uses the fixed panel's border and shadow directly, without generic inset-sheet overrides.
- The card anchors to the rounded chat frame's right edge instead of the Git button group's right edge.
- Compact card width is capped against the viewport, and reduced-motion preferences disable the transition.
- All action-row icons now receive an explicit 16 px square slot, including provider brand marks that otherwise retain a large intrinsic SVG size.

## Checks

- Focused web typecheck: passed.
- Project-script, Git-action, and chat-header tests: 72 passed.
- Focused lint, formatting, and diff validation: passed.
- The user-provided rendered screenshot exposed oversized Git and provider icons; the underlying unconstrained SVG path is fixed. Post-fix browser comparison was not run because browser automation permission was not provided.

## Follow-up verification

- Confirm the card clears the header and remains fully inside the rounded workspace surface.
- Confirm the chevron disappears exactly when the persistent card becomes visible.
- Confirm opening the right panel returns the card to compact disclosure.
- Confirm Add action, each configured script, Commit & push, alternate Git actions, installed editors, and Finder all still execute.

final result: blocked
