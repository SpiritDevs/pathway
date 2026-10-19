# Computer Use is a one-time port, with Synara kept as a read-only reference

Computer Use is ported once, as one large port, from Synara `main` at `eaa61eded` (2026-09-22). After the port, Pathway owns the code. We do not track Synara's changes, and the port does not keep its layout sync-friendly at the cost of Pathway idioms.

Synara is added to `.repos/synara` as a read-only reference repo alongside `effect-smol` and `alchemy-effect`. It is never edited or imported from. It is a place to study Synara's later Computer Use fixes, and other ideas, which we then rebuild by hand in Pathway. `vpr sync:repos` refreshes it from Synara's `main`; there is no package-version pin to follow.

The port also takes the open Linux stack, pinned at its 2026-09-23 heads: #1294 (`5f3f50397e`, core seams), #823 (`8f8d804828`, KWin backend), #824 (`83e03e49bb`, nested KWin) and #780 (`757001b231`, Hyprland). Without it, Linux would have only the read-only standalone host. The alternative macOS backend (#1010) is excluded. It was last restacked before #1090 merged, sits on the core #1090 replaced, and would compete with the merged macOS backend.

Continuous tracking was rejected because Pathway's plumbing (MCP toolkits, adapters, environment policy and autonomy) diverges from Synara's gateway at the edges. Mechanical syncs would keep reopening those seams.
