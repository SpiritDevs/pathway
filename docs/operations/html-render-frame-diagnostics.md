# Diagnose blank agent HTML frames in desktop

A blank `html_render` frame can be a navigation failure before the environment receives an asset GET. The desktop shell records renderer warnings/errors and failed loads, including subframes, in the existing rotating `userdata/logs/desktop.trace.ndjson` files. Both inline frames and the full-size dialog use the same renderer, and torn-out windows get the same diagnostics.

After installing a build with these diagnostics, reload the affected frame and read the trace around that time. Look for these span names:

- `desktop.window.rendererConsoleMessage`: Chromium's warning/error text, source URL and line number. Frame process/routing IDs are included when the source frame is still attached.
- `desktop.window.rendererProvisionalLoadFailed`: failed or cancelled navigations, including `ERR_ABORTED`.
- `desktop.window.rendererLoadFailed`: load failures reported by Electron's `did-fail-load` event.

Load spans include the original error code/description, destination URL, `isMainFrame`, frame process/routing IDs and window role. Console messages are also recorded as span events. Signed asset tokens, URL credentials, queries and fragments are removed; console text is capped at 4,096 characters. Match a redacted destination's origin and filename to the frame under investigation, and correlate frame IDs and timestamps with the console evidence and server asset traces.

These events preserve what Electron reports; they do not supply CDP's `blockedReason` or `corsErrorStatus`, and some browser checks may not emit a load event. A timeout or absence of an asset GET alone does not establish Local Network Access, CSP, HTTPS upgrade or any other specific cause. If the trace does not establish the reason, capture Network/Log events from the real renderer and its out-of-process iframe target with the maintainer's approval.

The diagnostics leave iframe navigation, sandboxing, permissions, response headers and retry behavior unchanged. Subframe failures do not reload the main window. They cover the Electron desktop shell; browser web and native mobile clients do not emit these desktop events.
