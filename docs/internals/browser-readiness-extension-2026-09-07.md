# Browser readiness: credentials, tabs, and capture

Date: 2026-09-07. Status: pre-implementation source findings and acceptance criteria. The subsequent build and verification are recorded in the [implementation report](astra-browser-verification-2026-09-07.md). Findings below describe the audited baseline unless explicitly stated otherwise.

This extends the [Astra readiness audit](astra-readiness-audit-2026-09-07.md) following Corey's explicit request for a strong in-app browser, recent T3 browser changes, agent-usable password managers and passkeys, reliable new tabs, screenshots, and video. The [decision record](../adr/0014-astra-questions-and-browser-scope.md) owns accepted choices. Independent web and native iOS use without a desktop remains required.

## Additional findings

### C1. Existing passkey integration authenticates Pathway, not arbitrary browser sites. P1

[DesktopClerk](../../apps/desktop/src/app/DesktopClerk.ts:75) configures the Clerk bridge for Pathway's renderer origin with passkeys enabled. The preload exposes that bridge. This does not establish WebAuthn support inside preview sessions. Searches of desktop, preview, MCP, browser, and contract source found no general password-manager integration, extension loader, or app.configureWebAuthn configuration. T3's inspected desktop source has the same distinction. Linux password-store settings choose secret storage; they are not a website autofill feature.

Pathway pins Electron 41.5.0. Its [versioned WebAuthn documentation](https://raw.githubusercontent.com/electron/electron/v41.5.0/docs/api/app.md#appconfigurewebauthnoptions-macos) supports a Touch ID authenticator with a matching signing entitlement. Credentials are device-bound, isolated by session metadata, and do not sync through iCloud Keychain. This is a possible local implementation, not proof that existing Apple Passwords passkeys will work. Later Electron documentation must not be used to promise APIs in this pinned release.

Required proof: registration and sign-in, existing versus newly created credentials, account selection, cancellation, timeout, profile separation, signed builds, and the supported operating systems. Test against the chosen credential providers. A virtual test authenticator can verify protocol plumbing but cannot establish real password-manager or biometric compatibility.

### C2. Password-manager extensions need a compatibility decision. P1

[Electron documents only partial Chrome extension support](https://www.electronjs.org/docs/latest/api/extensions). It loads unpacked extensions per persistent session and does not promise arbitrary Chrome Web Store compatibility. Installing a password manager in the person's usual Chrome browser does not install it in Pathway's preview partition or in remote Chromium.

Proposed direction: an agent requests sign-in for a selected site and account; a credential integration performs autofill or authentication; the agent receives completion or a request for human interaction. The selected manager determines the supported approval and unlock behavior. Keep raw passwords out of tool arguments, model-visible outputs, ordinary task history, and diagnostics. Since page evaluation can read filled password inputs, hiding a value in one tool's result is insufficient. The implementation must define what observation and capture are allowed during sign-in, and test those paths.

[1Password's Secure Agentic Autofill](https://1password.com/blog/closing-the-credential-risk-gap-for-browser-use-ai-agents) is a relevant reference for human-approved delivery into a remote browser. Its published integration uses Browserbase. This audit has not established an integration available for arbitrary self-hosted Pathway environments, or passkey support through that channel. Do not select Browserbase or promise reuse of this integration without checking the provider contract.

Cookie import can help establish a browser session, but it does not add a password manager, transfer passkey private keys, or guarantee the next sign-in. Keep those capabilities distinct in settings and acceptance tests.

### C3. Independent remote passkeys require more than a streamed browser. P1 feasibility question

[FIDO cross-device authentication](https://fidoalliance.org/passkeys/) verifies physical proximity using Bluetooth. Inference: displaying a remote server browser's QR code on an iPhone or desktop does not by itself provide a reliable passkey route to that server. A user's local authenticator is not automatically available to remote Chromium.

Investigate supported credential-provider remote authentication, a deliberate authenticator forwarding design, and supported site-specific sign-in handoff. Any forwarding must preserve the real relying party, challenge, origin validation, and authenticator consent. Running navigator.credentials.get on Pathway's own web origin cannot simply authenticate arbitrary third-party origins. A local browser completing OAuth also does not automatically transfer that session to the remote browser.

Choose the first supported manager and passkey sources before committing to the host architecture. Document which combinations support unattended sign-in, which require user verification, and which remain unsupported. Product approval for account reuse cannot bypass a provider's required biometric or device interaction.

### C4. Recording exists, but it is desktop-renderer owned and accumulates the whole clip. P1 for independent remote capture

[browserRecording](../../apps/web/src/browser/browserRecording.ts:446) records a canvas stream at 12 fps and 4 Mbps. The canvas contains decoded screenshot frames and supplies no audio track. Active recordings and chunks live in renderer memory. On stop, the entire recording becomes a Blob, then an ArrayBuffer passed to desktop IPC. [Manager.saveRecording](../../apps/desktop/src/preview/Manager.ts:2464) writes that buffer to the desktop artifact directory.

This can produce useful short evidence, but it does not satisfy recording owned by a remote environment with no desktop attached. It also makes long clips accumulate memory. The existing remote recording read path transfers chunks through the preview bridge, which remains tied to that host. A completed local path is not proof that another client can play or download the result.

Proposed direction: capture belongs to the browser host, with incremental output, bounded buffers, and a durable artifact reference that all authorized clients can access. Default to 30 fps for review clips if measured performance supports it; offer 60 fps only as an explicit quality option. Tab audio and microphone scope await the interview. Verify the actual codec on native iOS, authenticated playback, seeking, reconnect, cancellation, disk-full failure, and tab/process closure. Preserve useful partial output where supported and label incomplete clips.

### C5. Stalled screenshots and annotation conversion can hold the action path. P1 candidate confirmed in source

[Manager](../../apps/desktop/src/preview/Manager.ts:1936) captures screenshots and automation snapshots through unbounded capturePage promises. The polling deadline in automationWaitFor does not itself bound an individual debugger evaluation. [PreviewView](../../apps/web/src/components/preview/PreviewView.tsx:562) awaits annotation screenshot conversion without the newer upstream bounded wrapper.

Adapt upstream timeout and current-guest validation semantics. A late result from a closed or replaced tab must not become evidence for a different tab. Failed optional crops should keep the annotation usable, release composer state, and report that the image is missing. Do not retry state-changing actions merely because their response was late.

### C6. Page shortcuts can escape into Pathway controls. P2

[Manager](../../apps/desktop/src/preview/Manager.ts:1244) forwards selected page shortcuts into the host application. T3 removed that forwarding and disables host menu shortcuts for browser guests and popups. Apply the principle while deciding which explicit Pathway browser shortcuts remain available. An agent sending a page shortcut must not open settings or close the task panel accidentally.

## Additional T3 candidates inspected

Same source baseline as the original audit: pingdotgg/t3code at ea646c0834a3394ecb0be4a30c5d367e5a9002bd, history covering August 24 through September 7. Commit dates can differ by timezone; pinned hashes identify the exact changes.

| Change                                     | Source                                                                                                                                                                                                         | Pathway assessment                                                                                                                                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bound automation readiness and screenshots | [de1b798c, #4685](https://github.com/pingdotgg/t3code/commit/de1b798c6ed4223cabd64f56eadcc8f512963043)                                                                                                         | Adapt bounded waits, capture retries, and guest identity checks.                                                                                                                                              |
| Isolate browser keyboard input             | [b5fb3fba, #9840](https://github.com/pingdotgg/t3code/commit/b5fb3fba0fb3dbd1bc2e29886232321cc06863d5)                                                                                                         | Adapt to Pathway shortcuts and takeover behavior.                                                                                                                                                             |
| Release composer after capture failure     | [19c97ea5, #9127](https://github.com/pingdotgg/t3code/commit/19c97ea56d30b3a2de31a060f8f47d6b7404b78f)                                                                                                         | Preserve structured annotations if an optional image fails.                                                                                                                                                   |
| Stream host media across clients           | [beae2147, #9023](https://github.com/pingdotgg/t3code/commit/beae2147a9487ec47ac992319f2216914b4cb62d)                                                                                                         | Inspected asset and file-stream changes. Adapt authenticated media identity and seeking; T3 mobile UI is not Pathway's Swift iOS UI. Full client playback comparison remains required.                        |
| Recording quality and Electron correction  | [39581110, #8839](https://github.com/pingdotgg/t3code/commit/3958111057c10c10350dd9c20ec2a2df00f504be), [ef7014d8, #9001](https://github.com/pingdotgg/t3code/commit/ef7014d851f56bb037a9da963095ffd883c7fa08) | Inspected tab-stream capture and subsequent display-media grant sequencing. Choose a tested implementation for Pathway's runtime and remote host. Upstream also disables audio in the inspected capture path. |
| Password-store startup coverage            | [181e4511, #10287](https://github.com/pingdotgg/t3code/commit/181e45110f2d14950a5c1ec415faf3a049cb9b2e)                                                                                                        | Test maintenance for Linux secret-store startup, not password-manager support.                                                                                                                                |

The original audit already identifies OAuth popups, debugger lifetime, hidden rendering, duplicate frames, profiles, cookie import and follow-up fixes, close confirmation, literal navigation URLs, and preserving manual panel choices. Evaluate these as one browser backlog with explicit dependencies. Do not blindly cherry-pick T3's broad React Native, media, or Electron migrations.

## Proposed release acceptance matrix

Every applicable row needs desktop-local, remote-with-desktop, and independent web/iOS coverage. Agent and human entry points must use the same tab identity and ownership rules.

| Capability     | Required scenarios                                                                                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tabs           | Human and agent new tab, target=\_blank, modifier click, script-opened blank then navigation, popup registration, named-window reuse, switch, back/forward/reload, close, reopen, reconnect, multiple concurrent tasks. An action never silently reaches a replacement tab.                      |
| OAuth          | Preserve opener, postMessage, correct profile and cookies, redirects and callback, popup cancellation, opener closure, and remote visibility/input. A desktop-only native popup cannot satisfy independent iOS use.                                                                              |
| Passwords      | Selected manager installs/connects, locked/unlocked states, account selection, approved autofill, session reuse, expiration, revoke and sign-out, wrong-origin rejection, and agent continuation after human interaction.                                                                        |
| Passkeys       | Existing and new credentials, selected provider, local versus remote browser, platform versus roaming authenticator, user verification, cancellation, failure, and account/profile isolation.                                                                                                    |
| Screenshots    | Viewport, full-page, and element captures are proposed coverage; confirm which modes ship. Validate Retina/zoom coordinate mapping, iframes, tall pages, hidden tabs, timeouts, and stale results. Keep evidence-resolution images distinct from reduced model screenshots.                      |
| Video          | Start/stop from client and agent, navigation, resize, concurrent recordings, popup scope, hidden tabs, capture failure, bounded memory/disk behavior, client disconnect, correct duration, and usable final artifact. Define whether a recording follows one tab or a whole task's tab switches. |
| Media delivery | Authenticated playback, seek/range behavior, download, attachment to task, expiring-link refresh, actual native iOS codec support, and no dependency on the capturing desktop remaining online after transfer.                                                                                   |
| Interaction    | Keyboard, clipboard, file upload/download, select menus, drag/scroll, native prompts, and explicit takeover/resume. State which prompts require a person.                                                                                                                                        |
| Performance    | Idle and hidden CPU/GPU, action latency, frame rate under recording, PiP duplication, screenshot size, memory over a long clip, and relay bandwidth/backpressure.                                                                                                                                |

No new runtime checks were run for this extension. Earlier 289 passing focused tests remain baseline evidence only. Real browser, credential-provider, remote transport, and media tests require the previously requested browser permission and implementation of missing capabilities.
