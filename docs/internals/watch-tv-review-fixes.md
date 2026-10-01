# Watch/TV review fixes

Follow-up to the independent review of `1083336a4`, implemented on top of
`42b327641` without changing web UI. Hub patch identity is now
`0.12.0-pathway.2`, manifest revision 3. Contracts changed additively only.

## Fixed

1. **P1, standalone installer:** hub installation resolves Node through
   `resolveNodeExecutable` before running the patch. Initial setup and explicit
   updates share this path. It never uses the embedded standalone executable as
   a JavaScript runner. A mocked standalone installation test covers both calls.
2. **P1, public helper input:** both bundled entry points route acknowledged and
   legacy input through the same boundary. It reads family from the selected
   host's simctl runtime metadata, not a client field or display name. TV accepts
   only semantic remote buttons; touch, arbitrary HID, Crown and legacy phone
   controls cannot reach native input on TV. Watch payloads are bounded and
   family checked. A 64-call device queue serializes native completion, including
   keyboard down/up. Tests cover both wire formats, queue saturation, invalid
   coordinates/deltas and conflicting client metadata.
3. **P2, Android-only Mac setup:** shared hub installation writes TV helper source
   without invoking Apple tools. First TV input compiles the executable on its
   selected host. A compiler failure rejects TV input with a reason, while the
   shared hub remains installed. Local and SSH inventories separately expose
   `tools.tvInputBuild` as `notBuilt`, `ready` or `unavailable`; a missing executable
   cannot be reported ready. Process/build/inventory tests cover these states.
4. **P2, unavailable companion:** unpairing acquires the verified pair's iPhone
   UDID lease independently of available-device discovery. Another environment's
   lease still blocks it. The focused test removes an unavailable companion's
   pair and then pairs the Watch with an available replacement.

The real npm bundles exposed an additional syntax defect: prepending an import
before the standalone helper's shebang makes the script invalid. The patch now
preserves the shebang as the first line, covered by a parse test.

## Partial fixes

- **Input teardown:** queued input checks its originating socket after capture,
  family lookup and TV provisioning waits. Closed/revoked sockets cannot dispatch
  that pending work. Tests cover socket and capture-session closure. Input already
  handed to native code cannot be recalled.
- **Installation identity:** the patch now verifies the reviewed native addon's
  SHA-256 as well as the three JavaScript bundles. Native compilation records its
  source and output hashes, compiler version, developer directory, architecture
  and arguments. A changed native addon fails before patch publication. This is
  input verification and build provenance, not reproducibility of the full install.

## Deferred work

- **P2, active contacts on disconnect:** touch begin/move/end still lacks a shared
  gesture owner/lifetime across RPC and persistent viewer input. The RPC opens one
  socket per message; releasing every socket's touch on close would turn a valid
  RPC drag into separate taps. Add explicit gesture ownership/lifetime or retained
  RPC channels, then release contacts and held keys on disconnect, revocation and
  expiry. This patch cancels queued work but does not claim active-contact cleanup.
- **P2, Watch no-op acknowledgements:** the pinned Swift addon can return normally
  when Crown/arbitrary-HID symbols are absent or event construction fails. JavaScript
  cannot distinguish that from dispatch. Update and build the addon to return a
  checked result or throw, expose native capability probes, and gate advertised
  controls. Until then Watch `ok` means the method returned, not proven injection.
- **P2, full reproducibility:** npm's transitive graph is still resolved without a
  release-owned lock, and lifecycle scripts run before patch checks. Ship a locked,
  integrity-pinned complete artifact, including executable dependencies, and add
  independent artifact verification to release/tool-sync. The new version identifies
  this patch revision, not byte-equivalent installations. Intel native support is
  still unverified; the reviewed addon is arm64-only.

These deferred items need native/artifact or input-lifetime design changes. They
are not covered by a claim of release clearance.

## Verification

`vp test run` passed **139 tests across 20 focused files** covering the installer,
input boundary, pair recovery, lazy TV build, local/SSH inventories, authorization
and proxy. A final two-file recheck passed 11 tests after fixture typing and event
recording adjustments. Scoped `apps/server` and `packages/contracts` typechecks
passed. Targeted lint and formatting passed.

The optional `packages/client-runtime` typecheck reports the three pre-existing
`effect(globalDate)` diagnostics at `src/device/hubAccess.ts:16` and
`src/device/stream.test.ts:163,173`. Those files are unchanged from `42b327641`.
Commands used `vp exec tsgo --noEmit -p <scope>/tsconfig.json --tsBuildInfoFile /dev/null`.

The real npm 0.12.0 artifact retained by the independent review was patched in a
mock filesystem. Both entry points' extracted handlers rejected six unsafe TV
requests across the two wire formats and accepted semantic select. JavaScript
syntax checks run on both emitted bundles. Native compilation, native execution,
simulators, dev servers and live SSH/Connect are not exercised by this follow-up.
