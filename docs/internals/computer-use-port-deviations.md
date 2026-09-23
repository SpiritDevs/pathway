# Computer Use port deviations

Pathway's Computer Use is a literal port of Synara's (see ADRs 0036–0045). Each line records one
place where the port intentionally differs from Synara, so a reviewer comparing the two can tell a
deliberate change from drift. Add a line whenever you diverge; remove it if the divergence goes away.

## P1 — native

- Cua patches rename Synara product strings to Pathway (`pathway_native_revision`, `pathway_browser_input_control`, `_pathway_foreground_observation_ms`, `PATHWAY_CUA_*_OBSERVATION_MS`, `PATHWAY_CURSOR_PREVIEW_PATH`, `pathway_cua_overlay_init`/`pathway_cua_focus_restore` stderr lines, `pathway.compact` theme, `pathway-browser-l7`, `PathwayCuaCursorPanel`); code is otherwise unchanged and `cuaDriverRelease.json` carries the recomputed patch checksums.
- `provision-cua-driver`, `cua-cache-key` and `cua-artifact-provenance` are Effect TypeScript under `scripts/` instead of `.mjs` under `apps/desktop/scripts/`.
- Synara's `build-timing` helper is dropped; timing comes from Effect spans and logs.
- A shared `scripts/lib/native-command.ts` runs child processes; it replaces `build-timing` in the Cua cache-key inputs.
- `provision-cua-driver` defaults to `apps/desktop/.electron-runtime/cua-driver` rather than `apps/desktop/resources/cua-driver`, matching Pathway's gitignored staging root.
- The pinned-rustc error also suggests `RUSTUP_TOOLCHAIN`, since CI scopes the pin to the Cua steps.
- `provenance.json` is written as compact JSON through the Schema encoder.
- `provisionCuaDriver` is callable in-process, so the desktop build stages Cua without spawning a second Node process.
- The Cua driver's signing identifier is `com.spiritdevs.pathway.cua.driver`.
- `cuaDriverRelease.json` is exported from `@spiritdevs/shared` as a subpath so scripts can import it directly.
- The `provision-cua` action drops Synara's Xcode 16.4 pin (the self-hosted fleet runner owns Xcode and the cache key fingerprints it) and its benchmark step, adds a `targets` input, and scopes `RUSTUP_TOOLCHAIN`/strip overrides to its own steps so other Rust builds keep stable.
- `cua-cache-key` prints the key through `Effect.log`; CI reads it from `GITHUB_OUTPUT`, never stdout.
- The release build job timeout rises from 30 to 45 minutes to absorb a cold Cua build.
