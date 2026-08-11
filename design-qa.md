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
- Below the desktop rail breakpoint, global navigation rests as an empty 20 px frosted capsule within a safe-area-aware 44 px target; it contains no collapsed icons or dark handle line, expands immediately on pointer hover or touch press, retains active route state, and shares semantic light/dark theme tokens.
- The expanded mobile toolbar has no dedicated hide button; pointer exit, outside press, route selection, and Escape provide the existing close paths without adding another trailing control.
- The expanded mobile toolbar shrink-wraps its centered icon group and caps itself at the available viewport width, switching to horizontal scrolling only when its controls no longer fit.
- The collapsed 20 px navigation capsule is vertically centered within the reserved 44 px mobile header area, while its interaction target remains full-sized.
- Hover or touch expansion morphs the collapsed capsule into the full toolbar using transform and opacity only; the starting horizontal and vertical scales match the capsule footprint, and reduced-motion users receive the state change without animation.
- The shared mobile workspace body begins below a 44 px header reserve, while desktop continues to use the existing workspace top bar without additional margin.
- The independently fixed left-sheet toggle receives the same 44 px mobile header offset as the workspace body, keeping it centered in the body titlebar while retaining its desktop position.
- The shared mobile content frame clips to rounded top corners beneath the reserved header, while desktop retains its existing fully rounded frame.
- The mobile content frame casts a restrained upward shadow from its rounded top edge in both themes, while desktop retains the standard card shadow.
- Placeholder workspace headers now use the shared collapsed-sidebar titlebar inset, keeping Dashboard, Issues, Calendar, Email, and Orchestrator titles clear of the fixed left-sheet toggle.
- On phone widths, both left and right sheets fill the viewport width, begin below the shared 44 px header reserve, consume the remaining height, and use the same rounded top corners as the main content frame; tablet and desktop sizing remains unchanged.
- Mobile sheets enter from their owning edge over 240 ms with exponential deceleration and exit in 150 ms; larger right-panel sheets retain their shorter travel, and reduced-motion users receive an immediate transition.
- The mobile sidebar sheet clips its artwork and content to the shared rounded top corners, preventing the stage background from visually flattening the radius.
- The mobile left sheet remains mounted through Base UI's ending state, allowing its full-width exit translation to complete before the closed viewport is hidden.
- Right-panel callers now keep the controlled sheet mounted whenever content exists and toggle its `open` state instead of conditionally creating and destroying an already-open sheet, restoring both starting and ending animations in chat and Source Control.
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
