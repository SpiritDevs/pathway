# One general native helper for macOS

Synara's Swift helper ("AppSnap") is ported as Pathway's general macOS native helper, in `apps/desktop/native/pathway-helper/`. It is one binary with one line-delimited JSON protocol over stdio, one parent-exit monitor, and one build and signing step. Electron starts it in named modes.

Its first modes are the six that Computer Use needs:

- permission check, request and prepare
- the permission guide (GrantCoach)
- the physical Escape monitor
- the activation shield
- the window frame stream
- held-input release

Synara's `watch` mode (Option-chord capture) is not ported, because Pathway's SnapShot already covers that.

Future native macOS surfaces are added as further modes of this helper, not as separate binaries. The first expected one is a menu bar popover showing usage allowance and the apps Computer Use is driving. Long-lived surfaces like that run as a persistent mode, unlike today's short-lived ones.
