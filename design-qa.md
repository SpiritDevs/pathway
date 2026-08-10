# Design QA

- Source visual truth: `/Users/coreybaines/.t3/userdata/attachments/e1b548f1-c4e6-437e-a465-5adae7d68ba7-6c937380-e513-4524-96a0-dce62bfd612b.png`.
- Source pixels: 2354 x 1922 px.
- Implementation viewport: 1280 x 800 CSS px.
- State: desktop web, light mode, detached terminal card open below the main thread card.
- Requested outcome: center a horizontal resize indicator in the 8 px gutter and animate the terminal card as it opens and closes.

## Comparison evidence

Blocked. The supplied source was inspected at original resolution, but the collaborative preview snapshot failed twice after implementation, so rendered comparison evidence is unavailable.

## Implementation evidence

- The terminal resize hit area now occupies the full 8 px gutter above the detached card.
- Its one-pixel horizontal indicator is positioned at 50% of that gutter and appears on hover or active drag.
- The handle remains outside the rounded card's clipped surface so the indicator is not hidden.
- Terminal entry uses a 240 ms upward fade and terminal exit uses a 180 ms downward fade.
- Exit presence is retained for the full transition before the terminal is unmounted and the main card reclaims its height.
- Motion uses transform and opacity only, and reduced-motion users receive immediate state changes.

## Checks

- Focused web typecheck: passed.
- Thread terminal, preview shell, and secondary-sidebar tests: 29 passed.
- Focused lint, formatting, and diff validation: passed.
- Rendered handle centering, live dragging, and motion timing: blocked by preview snapshot failure.

## Follow-up verification

- Hover the gutter and confirm the horizontal line appears halfway between both cards.
- Drag the line and confirm terminal height changes without moving the line off-center.
- Toggle the terminal twice and confirm both entry and exit complete without flashing or clipping.
- Enable reduced motion and confirm the terminal changes state immediately.

final result: blocked
