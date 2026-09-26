# pathway-helper

The macOS native helper for Computer Use, ported from Synara's AppSnap helper. It is one binary
that the desktop main process spawns once per mode. It speaks NDJSON on stdout, one JSON object per
line, and exits when its parent does.

Build it with `node scripts/build-pathway-helper.ts [--arch arm64|x64|universal] [--release]`.
Run the native tests with `node scripts/build-pathway-helper.ts --native-tests`.

## Modes

Pass exactly one mode flag.

| Mode                         | Extra flags                                                                            | Emits                                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--check-permissions`        | `--permission accessibility\|inputMonitoring\|screenRecording` (repeatable)            | `permissions`                                                                                                                                     |
| `--request-permissions`      | `--permission …`, `--app-path <bundle>.app`                                            | `permissions`                                                                                                                                     |
| `--prepare-permission-setup` | `--permission …`, `--app-path <bundle>.app`                                            | `permissions`                                                                                                                                     |
| `--release-held-input`       |                                                                                        | `release-held-input`                                                                                                                              |
| `--permission-guide`         | `--pane accessibility\|input-monitoring\|screen-recording`, `--app-path`, `--app-name` | `permission-guide` (`granted` or `closed`); stdin `close` dismisses it                                                                            |
| `--computer-frames`          | `--window-id <n>`, `--out <unix socket>`, optional `--pid <n>`                         | `ready`, `error`; JPEG frames go to the socket, never stdout                                                                                      |
| `--escape-monitor`           |                                                                                        | `ready`, `escape`, `physical-input`, `escape-monitor-state`, `error`; stdin `arm` / `disarm`                                                      |
| `--shield`                   |                                                                                        | `ready`, `shield` (`engaged`, `refused`, `released`), `error`; stdin `engage <id> <x> <y> <w> <h> [label]`, `release <id>`, `release-all`, `quit` |

When no permission is selected, checks and requests default to Input Monitoring and Screen
Recording.

## Failures

Argument and startup failures emit `{"type":"error","code","message","capturedAt"}` and exit with
`EX_USAGE` (64). Unexpected errors use the code `helper_failed` and exit with 1. Diagnostics go to
stderr, prefixed `[pathway-helper]`.

## Signing

`Info.plist` is linked into the binary's `__TEXT,__info_plist` section. That keeps the code-signing
identifier at `com.spiritdevs.pathway.helper` through electron-builder's Developer ID re-sign, which
passes no `--identifier`.
