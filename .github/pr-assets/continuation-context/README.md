# Continuation dialog evidence

The screenshots render the actual `ContinuationDialog` component and application styles in a local Chromium browser with fixture provider data at 1000 x 720.

- `before.png`: component from main at `2db6d69d4`.
- `after.png`: updated component from this PR.
- Both updated workspace choices were clicked and their `current` and `new-worktree` selections verified.

These are component previews. Conversation inheritance, attachment preservation, fresh provider sessions, and summary preparation are verified by the focused server integration and unit tests.
