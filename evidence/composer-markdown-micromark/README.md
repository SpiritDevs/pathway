# Composer markdown (micromark parser) review evidence

These screenshots use the actual `ComposerPromptEditor` with the app stylesheet, mounted in a temporary page served by an isolated worktree dev server and driven by headless Chromium. They are not screenshots of the signed-in chat view: this machine has no Clerk development key, so the full app could not be signed in. The harness mirrored `ChatComposer`'s trigger detection, menu replacement and send path, but its menus always pick the first item.

- [The five second-round review cases](review-cases.png): `2*(3+4)*5` stays literal, emphasis spans quoted lines with every `>` muted, closing heading hashes are muted, `***` stops emphasis, and a fence after a list marker is a code block.
- [Chips, menus and the raw prompt](chips-and-raw-prompt.png): emphasis around file and skill chips, a quote and a fenced block, with the exact raw prompt that was sent printed beneath.

The browser pass typed each case with real key events and confirmed the raw prompt was unchanged. It also inserted and deleted a character at all 70 caret positions of a mixed prompt, from both directions, and checked that plain typing undoes in one step. It covered selection wrapping, delimiter deletion, the `@`, `$` and `/` menus, file, skill and terminal chips, multiline paste and a byte-identical send. At the 10,000-character limit, styling applied at 10,000 characters and cleared at 10,001. That check found the limit had ignored newlines, which is fixed in this branch.
