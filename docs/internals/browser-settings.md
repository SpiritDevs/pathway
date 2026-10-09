# Browser settings

Settings → Browser configures the desktop's built-in (local) browser. The user-facing guide is
[docs/user/browser-settings.md](../user/browser-settings.md).

## Where state lives

Every option is a client setting (`browser*` fields in `ClientSettingsSchema`), so it persists with
the desktop client's settings and is not shared with other environments. Helpers for the permission
shapes live in `packages/contracts/src/browserSettings.ts`. The desktop main process receives client
settings through the existing client-settings IPC and keeps a copy in `BrowserSession`.

Browsing history stays in the web client's `browserHistoryStore`. Downloads are tracked by the
desktop (`BrowserDownloads`). Saved passwords use the existing Convex-backed password store.
Addresses are client settings.

## Who enforces what

| Rule                                                               | Enforced by                                                                      |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Agent control, browse access, history access, site tools, full CDP | Desktop web host (`PreviewAutomationHosts`) before running an automation request |
| Agent download access                                              | Desktop main (`BrowserDownloads`), using the agent-activity mark on the tab      |
| Site permissions                                                   | Desktop main (`BrowserSession` permission handlers)                              |
| Download location and save dialog                                  | Desktop main (`BrowserDownloads`)                                                |

Approval prompts (agent site approval, history approval, site permission Ask) render in the desktop
renderer from `PreviewAutomationHosts`. Site permission requests that go unanswered are denied by
the desktop after a timeout.

## Boundaries

- Desktop only. The section, its subpages and the related command palette entries are hidden on web
  and mobile; the routes redirect to General outside Electron.
- The remote browser on an environment does not read these settings. It does not advertise the
  desktop-only automation operations, and agent permissions do not apply to it.
- There is no upload column in agent permissions: the built-in browser has no upload interception.
