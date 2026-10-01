# Simulator build and run

COR-105 adds environment-owned Xcode jobs. `SimBuildService` is shared by WebSocket RPCs and the device MCP toolkit. The client never executes Xcode, reads a local app bundle, or connects to a device host directly. Web, desktop and mobile can use the same authenticated environment connection over local, remote, relay or tunnel transport.

## UI contract

Import schemas and types from `@spiritdevs/contracts/simBuild`. Every request includes `SimBuildContext`: `environmentId`, `projectId`, and `threadId`. The server verifies the environment and the thread's project, then uses the thread's worktree when attached, otherwise the project's directory. Rootless projects are rejected.

| RPC                  | Input beyond context              | Result                                                  | Scope                   |
| -------------------- | --------------------------------- | ------------------------------------------------------- | ----------------------- |
| `simBuild.discover`  | None                              | `SimBuildDiscovery`                                     | `orchestration:operate` |
| `simBuild.start`     | `SimBuildStartInput` fields below | `SimBuildJob` accepted in `resolving`                   | `orchestration:operate` |
| `simBuild.list`      | None                              | Recent `SimBuildJob[]` for this thread                  | `orchestration:read`    |
| `simBuild.get`       | `jobId`                           | `SimBuildUpdate` snapshot                               | `orchestration:read`    |
| `simBuild.cancel`    | `jobId`                           | Terminal `SimBuildJob`, after the child exits           | `orchestration:operate` |
| `simBuild.subscribe` | `jobId`                           | Stream of `SimBuildUpdate`, ending after terminal state | `orchestration:read`    |

Discovery runs `xcodebuild -list -json`, which can resolve project dependencies, so it requires operate scope. It returns `workspaceRoot`, `developerDir`, `framework`, `containers`, and `notices`. Each container has a relative `path`, `kind: project | workspace`, `schemes`, `targets`, and `configurations`. Workspace listings may have empty target/configuration arrays because Xcode lists those on projects. Companion project listings provide that inventory. A scheme with multiple application products requires an explicit application `target` at start.

Start takes `action: build | run | test`, `requestId`, `hostId`, `deviceId`, `containerPath`, `scheme`, optional `configuration`, and optional `target`. Use the exact relative container path from discovery. `target` selects the app product from a scheme for build/run; it is not an arbitrary xcodebuild argument. Retain `requestId` across retries of the same request. Reusing it with changed arguments or a changed checkout fails. Generate a new id for a deliberate new build.

The destination must be an available, nonphysical iOS simulator with `hostId: local` on the project's environment. `local` describes the environment machine, including when the watching client is remote. A simulator owned by another environment is rejected. Device ownership is claimed before building and rechecked before install and launch. SSH device hosts and Android builds are outside COR-105.

`SimBuildJob` includes the original input, `id`, `workspaceRoot`, pinned `developerDir`, `phase`, `terminal`, `artifact`, `failure`, and timestamps. An artifact has `appPath`, `bundleId`, and `target`, all resolved on the environment.

- Run phases are `resolving → building → installing → launching → running`.
- Build and test finish in `completed` after `building`.
- Any active phase can finish in `failed` or `cancelled`.
- `terminal` is the authoritative completion flag. `running` means `simctl launch` succeeded. It does not monitor subsequent app exits.
- A failed job has a typed `failure.code` and display message. Display diagnostics from its logs alongside that message.

## Logs and receipts

A `SimBuildUpdate` has `kind: snapshot | update`, current `job`, `receipts[]`, `logs[]`, `firstLogSequence`, and `nextLogSequence`.

Each phase receipt is `{ kind: phase, sequence, job }`. Its per-job sequence starts at 1. The server persists the receipt before publishing it. The latest receipt projects the durable job state. Jobs retain their phase history; output is not written into the receipt journal.

Each log chunk is `{ sequence, text, diagnostics[] }`. Chunk sequences are independent of receipt sequences. Diagnostics contain `severity: error | warning`, `message`, and nullable `file`, `line`, and `column`. File paths are absolute paths on the environment; open them through that environment's file/editor facilities. Compiler paths are resolved relative to the project checkout. Diagnostics without a source location remain visible but have no file link.

The server batches short output for 100 ms or until 16,384 characters accumulate. It keeps at most 65,536 characters and 64 chunks per job, with at most 128 diagnostics per chunk. Long unterminated lines are bounded too. Both child pipes await their output consumer. Each subscriber has one sliding notification slot. When it can receive again, the server derives a delta from its cursors: all missing phase receipts and the retained log tail. If `firstLogSequence` exceeds the client's next expected log sequence, show a truncation notice. Do not describe the tail as a complete build transcript.

Subscribe before or after start completes; registration and the initial snapshot cannot miss an intervening transition. Reconnecting starts with a snapshot. The stream closes after emitting a terminal update. Disconnecting or hiding the panel releases the subscription without cancelling the job.

Use `createSimBuildEnvironmentAtoms` from `@spiritdevs/client-runtime/state/simBuild`. It provides `discover`, `start`, `list`, `get`, `cancel`, and a `view` subscription family. Commands take the standard `{ environmentId, input }` target; the subscription family is keyed by that same environment and input. Keep the outer registry environment and the payload's `environmentId` identical. `view` folds updates into `SimBuildView` with bounded `logs`, deduplicated `receipts`, `job`, `nextLogSequence`, and `logsTruncated`. Mount only while visible. UI components and navigation entry points are a separate implementation.

## Execution and recovery

`SimBuildHost` discovers native containers within three directory levels, including `ios/`. It skips dependency and build directories and does not traverse symlinks. Discovery is limited to 2,000 visited directories and 64 containers. Expo projects without generated native files report that prebuild is needed. CocoaPods installation, Expo prebuild, and Metro management remain explicit project preparation steps.

COR-101 selects Xcode through `xcode-select`. Each job clears an ambient `DEVELOPER_DIR` while reading that selection, then pins the returned developer directory for every xcodebuild and simctl process. A later selection change does not redirect an active job. RN/Expo default to Release to bundle JavaScript; native Xcode projects default to Debug. Choosing Debug for RN/Expo requires the project's Metro server separately.

Each job uses `stateDir/sim-build/<jobId>/DerivedData`. The sequence boots the chosen simulator if needed, waits with `simctl bootstatus -b`, invokes xcodebuild with the explicit destination and disabled signing, reads JSON build settings to locate one simulator `.app` within that job's DerivedData, then runs `simctl install` and `simctl launch --terminate-running-process`. Test jobs invoke `xcodebuild test` and do not perform the install/launch sequence. Xcode manages the test runner.

The runtime allows one active job per project or simulator and at most three per environment. The accepted start is durable and independent of a WebSocket or MCP request lifetime. Cancellation aborts the active captured child, escalates from SIGTERM to SIGKILL after five seconds if needed, and waits for process/output drains before publishing `cancelled`. It never discovers PIDs, signals a process group, shuts down a simulator, or terminates a previously launched app. It does not claim to terminate every descendant spawned by Xcode build scripts.

Receipts are saved through fsync and atomic rename to `stateDir/sim-build/receipts.json`. The journal retains approximately the most recent 50 jobs plus active jobs. The runtime reconstructs jobs from receipts on first access and records a failed `interrupted` receipt for unfinished work after an environment restart. Jobs are not silently resumed. Live log tails do not survive restart. DerivedData is retained for inspection and is not automatically deleted. A storage failure stops the job; if its final receipt cannot be saved, clients receive a terminal `storage-failed` state without a fabricated receipt, and restart recovery handles the last persisted phase.

## Agent tools

The production device MCP catalog exposes `device_build_discover`, `device_build`, `device_run`, `device_test`, `device_build_status`, `device_build_wait`, and `device_build_cancel`. They use the calling credential's environment, project and thread, with no caller-supplied project override. Every call checks the existing device capability and current device/agent consent. All providers receive the common catalog; Claude's read-only allowlist includes status and wait.

The self-test loop is discovery, `device_open`, `device_run`, `device_build_wait`, then the exact `agent-device` snapshot/click/fill invocation returned by `device_open`. `device_test` runs a scheme's XCTest suite. Status returns the same bounded logs and receipts as the UI. Wait awaits the worker drain and returns its terminal job. Agent tools return accepted jobs promptly, so cancellation and status remain available from another request or client.

## Verification

Tests inject xcodebuild and simctl at `SimBuildProcess`, use temporary project directories, and wait on receipts, explicit process gates and worker drains. The process adapter has a separate mocked-child test for signal targeting, pipe consumption and bounded JSON responses. No real Xcode build, simulator, browser, dev server, or live Pathway database is required. Client tests cover reconnect replacement, replay deduplication and log truncation. MCP tests use the production catalog and verify consent and calling-thread binding.
