# Computer Use native build scope

The port takes Synara's native build in full:

- **The Cua driver build**: the pinned upstream commit with a checksum check, both patches, Rust 1.97.1, and verification against the release manifest.
- **The Swift helper**, built with `swiftc`.
- **Path-filtered CI** for macOS and Linux: Rust and Swift regressions, plus the Linux Xvfb smoke test through the real Electron host.
- **Synara's isolated `cua` build flavor**, adopted as a Pathway flavor. It has a separate bundle ID and home directory, so testing never touches the user's real Pathway permissions.

From Synara #1291, only the Cua build cache comes over: `provision-cua`, fingerprinted cache keys and their tests. The rest of #1291 re-plumbs Synara's entire release pipeline: portable JS artifacts, notarization moved into `afterSign`, sharded gates and benchmarking. None of that is Computer Use, and Pathway's `release.yml` already signs and notarizes correctly, so this is the one deliberate exception to the literal mirror ([0039](0039-computer-use-is-a-literal-mirror-of-synara.md)). It can be taken later from `.repos/synara` as a separate change.

Pathway's Developer ID signing matters here. macOS ties Accessibility, Input Monitoring and Screen Recording grants to the signing identity, so Pathway's signed releases keep grants across updates in a way Synara's ad-hoc builds could not.
