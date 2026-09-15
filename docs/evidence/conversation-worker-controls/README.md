# Conversation worker controls — review evidence

[Public visual review on PlanLink](https://planlink.spiritdevs.com/d/jy29e7gfxodb) · [16-second walkthrough](https://coal-specified-conversations-debug.trycloudflare.com/worker-conversations/conversation-walkthrough.mp4)

Captured on 15 September 2026 from the real web client in an isolated development environment and a dedicated Clerk development account. The conversation contains invented sample data. Its worker environment is deliberately disconnected: screenshots demonstrate the production UI and real Convex mutations, not live provider execution. Runtime delivery is verified separately by focused tests.

## Images and recording

- `00-pr173-before.png`: the earlier PR #173 component fixture, with simulated backend; documents the form UI being replaced.
- `01-conversation.png`: conversation with a worker question and flat work summary.
- `02-quoted-reply.png`: replying to the worker question in the main composer.
- `05-queue-actions.png`: queued-message context menu.
- `06-edit-in-composer.png`: editing a pending instruction in the existing composer.
- `09-final-conversation.png`: saved edit and delivery states.
- `10-dark-mode.png`: dark appearance.
- `11-narrow-web.png`: 390 × 844 responsive web layout, no horizontal document overflow.
- `12-images-and-video.png`: real image upload and inline video playback.
- `conversation-walkthrough.mp4`: right-click Reply, send with motion, then edit and save. Idle time trimmed; interaction playback speed unchanged.

## Validation

166 focused tests passed across `aiOrchestrators`, cloud orchestrator and worker controls, V2 asynchronous questions, conversation attachment drafts and send motion. The final backend/control rerun passed 127 tests. Server, web and backend package typechecks passed, plus targeted lint and `git diff --check`.

Integrated browser checks covered quoted question replies, worker follow-ups, edit/save, queue order, cancellation, Escape, preserving the previous draft and its uploaded attachment through both cancelling and saving an edit, image loading, video playback and one composer. A stale-revision race was rejected by the backend. Queue positions updated correctly after reordering.

The first automation upload attempt used relative file paths and failed before sending bytes. Retesting with absolute local paths passed; this did not require an application upload change. The video element advanced in time with no media error, and the image reported a nonzero natural width.

## Surface coverage

- Web: floating conversation and its shared composer/message components; light/dark and narrow viewport checked.
- Desktop: shares these web components; packaged Electron was not launched.
- Mobile: native UI deferred; new wire fields are optional.
- Providers: controls use the existing provider-independent V2 thread/runtime-request path. Only supported Pathway-owned descendants are addressable; native provider children are not independently steerable. Live runs were not launched per provider.
- Connections: cloud delivery has revision fencing, receipts and reconnect recovery tests. No new localhost origin is introduced; attachment transfers use the existing authenticated flow.
- Reverse actions: cancel reply/edit, remove queued instructions and stop work are present.
- Documentation: user guide and architecture note accompany the implementation.

The PlanLink screenshots are embedded as lossless WebP images. The public recording uses the existing temporary review tunnel; the same MP4 is retained here for durable repository evidence. No credentials or pairing links are included.

## Message receipt refinement

The latest PlanLink version shows **Sending**, **Delivered** and **Read**, plus group reader avatars. Screenshots `13`–`17` and `read-receipts.mp4` capture the updated real client. The reader acknowledgements in the video are scripted development fixture updates, not live provider reads. The preceding send uses the real conversation mutation. The temporary fixture function was removed after capture.

135 focused tests passed for orchestrator behavior, receipts and timeline grouping after this refinement. Tests cover monotonic human read positions, joined-history boundaries, current-participant visibility, explicit orchestrator reader identities, queue-independent delivery labels and one latest outgoing placement per reader. Web and backend package typechecks and targeted lint passed.

The browser verified Delivered changing to Read, both configured orchestrator avatars moving to the newest message, and the same display at 390 pixels without document overflow. Human read acknowledgements now follow messages visible in a focused conversation. Cancel and Retry moved to the message menu. The earlier queue-labelled screenshots are retained as the preceding iteration’s evidence.
