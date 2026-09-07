# Environment browser setup

The environment browser runs Chromium beside the Pathway server. Web and iOS clients send input and receive compressed screenshots through the authenticated environment connection. A connected Electron desktop is not required. Each task has a persistent browser profile under the environment state directory. A client disconnect does not close its tabs. Deleting the task closes its browser context and releases its active-session slot; the profile remains on disk, and captures keep the existing attachment retention policy. Each environment allows up to eight active task browser contexts. Closing the final tab stops that task's Chromium process while retaining its profile.

Install the browser runtime on every environment that will host browser work:

```sh
npx playwright@1.60.0 install chromium
# Linux hosts may also require system packages:
npx playwright@1.60.0 install-deps chromium
```

Video recording requires full FFmpeg with the `libx264` encoder. On macOS, install `ffmpeg` through Homebrew. On Linux, use the distribution's FFmpeg package. Set `PATHWAY_BROWSER_FFMPEG` to an absolute executable path when it is not on the Pathway server's PATH. Playwright's small cached video encoder cannot produce this MP4 format.

Recordings capture one selected tab without audio. The encoder writes to disk while recording. A recording ends at ten minutes or approximately 500 MiB. Screenshots and videos use the environment's attachment storage and signed, expiring download URLs. The asset endpoint supports single byte ranges for video seeking. Capture ownership and metadata are stored in a per-task index, so reopening the capture list after a server restart can issue fresh download URLs. Opening the capture list again refreshes its download URLs. Existing attachment retention rules apply; this change does not add a separate cleanup scheduler.

Desktop users can select the desktop browser or the environment browser in the browser panel. Browser automation remains attached to the selected host. Switching hosts while an action is in flight or while a different host is under human takeover is rejected. An explicitly selected disconnected host does not silently fall back to another browser profile. Selection currently survives client reconnects within one server process. After a server restart, select the intended host again.

When an agent is working, take browser control before clicking, typing, or navigating. Resume the agent when finished. Both the automation broker and the environment's action queue enforce the takeover boundary.

The browser profile belongs to the environment and task. A remote host does not gain access to the person's Apple Passwords or iCloud passkeys by streaming its screen. See [Apple browser authentication](browser-passkeys.md) for the separate platform requirements.

## Verification

Run the explicit integration script from the repository root after installing Chromium and FFmpeg:

```sh
node apps/server/scripts/verify-remote-browser.ts
```

It creates a temporary browser profile and a loopback-only fixture, fills synthetic login data without submitting, checks origin rejection and popup ownership, captures a PNG and MP4, checks recording duration with `ffprobe`, and closes its browser and fixture server. The output identifies the retained evidence directory. It does not use a real website account.
