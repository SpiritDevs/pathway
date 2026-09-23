# Computer Use controls the environment's host machine

The computer an agent drives is always the host machine of the environment running the thread, never the client's device. On macOS, the Pathway desktop app is the Computer Host, because the native safety layer (Swift helper, patched Cua driver, physical Escape monitor) lives in the Electron shell. A headless `npx @spiritdevs/pathway` server gets Synara's standalone host, with its restrictions: native desktop input stays closed, and only observation and verified browser paths are available.

macOS permission grants are set up only at the host machine. A remote client that hits missing grants gets a "set up on the host" card and never requests grants on its own device.

Every client can start a Computer task, approve actions, press Stop and watch the preview: web (local and app.spiritdevs.com), a remote desktop, and the native iOS app. Remote preview uses Synara's still-frame stream: one window or tab, about 2 fps, unchanged frames skipped, running only while someone is watching. The live JPEG socket stays local to the host desktop. The physical Escape kill switch is host-only; remote clients rely on Stop.

Synara is desktop-only and never faced this question. We chose host-only control because the environment already owns the filesystem, credentials and provider processes, and Computer Use extends that ownership to its screen. Remote preview is limited to window-scoped stills to respect relay and tunnel bandwidth.
