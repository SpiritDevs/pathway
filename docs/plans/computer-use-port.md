# Computer Use port plan

This plan ports Synara's Computer Use feature into Pathway in full. The decisions behind it are in ADRs [0039](../adr/0039-computer-use-is-a-literal-mirror-of-synara.md)–[0048](../adr/0048-pathway-owns-computer-approvals.md), and the vocabulary is in the "Computer Use" section of [the glossary](../internals/glossary.md). Read both before building anything. This file describes how the work is divided and delivered. It is not a spec: the spec is Synara's code and tests.

## Source

- Synara `main` at `eaa61eded`, vendored read-only at `.repos/synara`. Never edit or import from it.
- Linux stack, not on `main`, pinned at these heads:
  - #1294 `5f3f50397e`: core hooks
  - #823 `8f8d804828`: KWin
  - #824 `83e03e49bb`: nested KWin
  - #780 `757001b231`: Hyprland

  Read them with `git -C /tmp/synara show pr-<n>:<path>`, or fetch `pull/<n>/head` yourself.

- #1010 is excluded. From #1291, only the Cua build cache is taken ([0046](../adr/0046-computer-use-native-build-scope.md)).
- Licences:
  - Synara is MIT (T3 Tools Inc. and Emanuele Di Pietro).
  - The Cua driver is MIT (Cua AI, Inc.).

  Keep both notices beside the ported code (see `THIRD_PARTY_LICENSES`) and ship `CUA-LICENSE.txt` with the driver.

## Porting rules

1. **Effect everywhere in TypeScript** ([0045](../adr/0045-computer-use-is-rewritten-in-effect.md)). Read `.repos/effect-smol/LLMS.md` first. Model services with `Context.Service`/`Layer`, errors with `Schema.TaggedErrorClass`, processes with `effect/unstable/process`, and tools with `effect/unstable/ai` `Tool`. Copy the patterns of neighbouring Pathway code, such as `apps/server/src/preview`, `apps/server/src/mcp/toolkits/*` and `apps/desktop/src/snapShot`. Swift and Rust stay native.
2. **Synara's tests are the spec.** Port every Synara test case for a module to `@effect/vitest` beside the ported module. A module is done when its ported tests pass. If a test cannot apply, or behaviour intentionally differs (renames, Pathway-owned approvals, access policy, autonomy ceiling, helper modes), add one line to `docs/internals/computer-use-port-deviations.md` giving the Synara test or behaviour, what Pathway does instead, and why.
3. **Renames.**
   - Synara → Pathway in product strings.
   - `SYNARA_*` environment variables → `PATHWAY_*`.
   - The "AppSnap" helper → `pathway-helper` ([0047](../adr/0047-one-general-native-helper-for-macos.md)).
   - Synara's `agentGateway` → Pathway's MCP toolkit.
   - Keep `computer_*` tool names exactly.
4. **Use Pathway's structures, not Synara's.** Wire contracts, RPC, settings, auth scopes, MCP catalog, orchestration events and provider adapters through Pathway's existing systems. Where Synara had a bespoke mechanism and Pathway already has one (SnapShot capture, `MacPermissionSetup`, the Electron Tray, the preview browser), reuse Pathway's and record the substitution as a deviation.
5. **Out of scope:**
   - Synara's AppSnap screenshot feature, `watch` mode and Option-chord capture (SnapShot covers these).
   - Synara's marketing site.
   - `docs/computer-use-cua/evidence`.
6. **Performance** (AGENTS.md):
   - Remote preview is window-scoped still frames at about 2 fps, deduplicated, and sent only while someone is watching.
   - The live JPEG socket stays local.
   - No continuously repainting animation.
7. **Verification.** Run `vp test run <files>` for the files you touched, plus targeted typechecks (`vp run --filter <pkg> typecheck`, or `tsc -p` for the package). Never run repo-wide checks, start dev servers or browsers, or touch `~/.pathway/userdata`. Never kill processes by pattern.
8. **Commits.** Use conventional commits, one logical step per commit, ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Do not push or open PRs. The coordinator does that.

## Stack

Each phase has one branch, one worktree (`~/GitHub/pathway-cu-pN`) and one PR, stacked in this order. Phases marked ∥ are built in parallel on top of P0 and restacked afterwards; they touch disjoint files.

| PR   | Branch                              | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0   | `feat/computer-use-p0-foundations`  | ADRs, glossary, this plan, `.repos/synara`. Contracts: `packages/contracts/src/computer*.ts`. Pure shared modules: `cuaDriverProtocol`, `computerGrants`, `computerFrame`, `computerKeyNames`, `cuaActionDiagnostics`, `computerInvocation`. The `computer:operate` scope, the access policy and the autonomy ceiling schemas.                                                                                                                                                                                          |
| P1 ∥ | `feat/computer-use-p1-native`       | The Cua driver build: `native/cua-driver` patches, provisioning with checksum and manifest verification, Rust 1.97.1, `cuaDriverRelease.json`, provenance, and the cache key from #1291. The Swift `native/pathway-helper` with its six modes and native tests. Packaging and signing in `scripts/build-desktop-artifact.ts`. The `cua` flavor.                                                                                                                                                                         |
| P2 ∥ | `feat/computer-use-p2-server-core`  | `apps/server/src/computer/**`: the manager, backends (Cua, Fake, Unavailable), approval gate, lease and queue, denylist, audit log and history, space broker, still-frame publisher, geometry, scroll calibration, UI-tree targeting, and the Layers.                                                                                                                                                                                                                                                                   |
| P3 ∥ | `feat/computer-use-p3-desktop-host` | `apps/desktop/src/computer/**`: the Cua driver host and standalone host, host socket, runtime ownership, the helper manager (the AppSnap manager minus the snap feature), Escape kill switch, shield, frame tap, emergency-stop notice, lifecycle, IPC and fixtures.                                                                                                                                                                                                                                                    |
| P4   | `feat/computer-use-p4-tools-policy` | The MCP `computer` toolkit (`computer_*`, `computer_browser_*`, space tools, guidance, progress guard, turn presence), Pathway-owned approvals ([0048](../adr/0048-pathway-owns-computer-approvals.md)), the access policy ([0041](../adr/0041-computer-access-is-an-environment-policy.md)), the autonomy ceiling ([0042](../adr/0042-computer-autonomy-is-an-environment-dropdown.md)/[0043](../adr/0043-computer-autonomy-is-an-environment-ceiling-over-thread-mode.md)), WS handlers and RPC, and the frame route. |
| P5   | `feat/computer-use-p5-providers`    | Claude, Codex, Cursor, Grok, OpenCode and ACP adapters: attach the toolkit, auto-allow `computer_*`, raise MCP timeouts, and add `/computer-use`.                                                                                                                                                                                                                                                                                                                                                                       |
| P6   | `feat/computer-use-p6-clients`      | Web and desktop: the Settings → Computer page, permission guide, getting started, audit history, preview popover and stream, transcript presentation, approval, setup and denied cards, the composer hint, and the status badge.                                                                                                                                                                                                                                                                                        |
| P7   | `feat/computer-use-p7-ios`          | `apps/pathway-ios`: the Computer settings page (editable with admin scope), approval cards, Stop, and the still-frame preview.                                                                                                                                                                                                                                                                                                                                                                                          |
| P8   | `feat/computer-use-p8-linux`        | The Linux stack (#1294, #823, #824, #780), Linux admission, the Escape monitor and the standalone host.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| P9   | `feat/computer-use-p9-ci-docs`      | Path-filtered macOS and Linux CI, the Xvfb smoke test, qualification, `docs/user` and `docs/internals`.                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Review loop

For each phase:

1. An Opus 5.5 builder builds it.
2. Two independent audits run: Fable 5.1, then GPT-6 Astra at Extra High effort.
3. The builder fixes every verified finding from either audit.
4. The coordinator rebases the stack onto the latest `main` and opens the stacked PR.
