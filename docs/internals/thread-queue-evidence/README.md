# Durable queue verification

Verified on 10 September 2026 using an isolated Pathway worktree, local Convex backend, development
Clerk account, and Helium. Two synthetic registered environments remained disconnected throughout
the browser pass. No production backend was deployed or used for the queue fixtures.

- Created a conversation for a registered offline environment from the normal new-thread picker.
- Saved multiple messages and an attachment to cloud without connecting that environment.
- Edited a queued message, canceled an attachment message, and retried it successfully.
- Moved the unstarted thread to a different registered environment while retaining its thread ID
  and all pending messages.
- Stopped the isolated Convex backend, saved another prompt and file on the device, then restarted
  cloud. The outbox synced the saved request and file without re-entering either.
- Navigated to Settings and back, switched between queued threads, and reloaded the application.
  Messages remained accessible in the sidebar.

The before image captures the original picker behavior during integration: only the connected
machine was listed. The after image shows the saved queues and the reassigned destination. The
video records navigation through Settings and between the two stored queues.

![Original destination picker](before.png)

![Saved queue after recovery and reassignment](after.png)

[Navigation recording](navigation.mp4)

Focused automated verification covered 47 backend/registry tests, 139 web/shared-client tests,
57 server tests, 9 native queue tests, and 10 native draft-recovery tests across targeted runs.
Scoped TypeScript checks and lint passed. iPhone, iPad, and visionOS builds passed; the three new
Swift files passed SwiftFormat and strict SwiftLint.

Native tests excluded the unrelated, pre-existing noncompiling `PathwayProjectIconTests.swift`.
The visionOS build retained an existing camera-usage-description warning. Provider execution and
reconnection ownership were verified with focused server tests, not a live provider through a
production tunnel. Desktop uses the tested web implementation; no separate Electron shell pass
was performed.
