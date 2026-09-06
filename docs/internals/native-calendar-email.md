# Native Calendar and captured Email

The native Calendar and Email surfaces consume the same company replica as desktop. Both models project only domain-relevant entity versions, so incoming agent transcript changes do not re-sort the inbox or calendar. Company IDs remain part of every row identity and write.

## Integration

`PathwayCalendarModel(cloudRequest:mutateWorkItem:)` receives the authenticated Convex request closure and the existing Issues mutation adapter. Feed `replaceReplica(_:companies:)` alongside the issue projection. Render `PathwayCalendarView(model:companies:)`.

Calendar mutations use `calendars:*` operations directly. Date-only work changes use `issue.update`, `issueMilestone.update`, and `issueCycle.update` through the issue outbox adapter; they never synthesize timestamps for work dates. Only the current membership's Pathway-owned calendars expose editing. Missing calendar grants remove corresponding events even when an event row is still present in the local replica. Event detail and calendar sharing screens resolve current records rather than retaining readable snapshots after revocation.

`PathwayEmailModel(cloudRequest:environmentRequest:)` receives an environment request closure with **company ID and exact source environment ID**, not a project-based environment guess. Feed `replaceReplica(_:companies:)` and render `PathwayEmailView(model:companies:environments:)`.

Captured messages are cloud-readable even when their source environment is offline. Read/unread and capture settings require that source environment. Tags, trusted senders, and deletion use the existing cloud administration mutations. Bulk changes retain successful writes if a later source fails, and show the failure instead of pretending the whole batch succeeded.

## Content and attachments

Calendar attachments follow the existing reserve, POST, attach sequence, with reservation cleanup after failure. Size and count match desktop's 25 MiB and eight-file limits. Uploads stream from a file URL.

Captured Email displays body, headers, diagnostics, SMTP transcript and attachment metadata. The desktop reader likewise exposes attachment metadata; no attachment-download RPC exists in the email contract. Attachment bytes and raw EML stay on their source environment.

Email HTML uses an ephemeral WebKit data store, disabled JavaScript, a restrictive CSP, blocked frames/forms, and explicit handling for external links. Remote images/styles are disabled unless the reader enables them or the exact sender is in the company's trusted-sender catalog. The plain text and headers views remain available.

## Validation and remaining boundaries

Ten focused native tests cover calendar ownership/revocation, integer event timestamps, preservation of invitee responses, failed mutations, exact-source email writes, and date-only work contracts, overlapping schedule lanes, trigger validation and nullable retention overrides. The models and views were separately typechecked against the iOS Simulator and visionOS Simulator SDKs. Full app integration and on-device rendering remain the primary agent's responsibility.

Calendar supports agenda/day/week/month periods, a graphical month picker, a bounded dated-work timeline, event editing and calendar administration. The Day and Week views include hour grids, overlapping-event lanes, drag-to-move, resize handles and accessibility adjustment actions. Multi-day events clip to each actual local day, including daylight-saving days. Reminder offsets are saved on the real events; background delivery belongs to the native notification integration, not this model. Dated work can be edited from the calendar.

Email capture controls include listener enable/address/port, retention, notification settings, and existing project routing/code extraction fields. Capture analytics, project-specific retention overrides, trigger-rule creation/editing/enabling/deletion, and paginated firing history are available from capture settings. A settings read reconciles missing project capture inboxes on the server, matching desktop; native does not invent a separate provisioning mutation. Clearing a project inbox requires an explicit confirmation. Outbound email and Gmail/Outlook sync are outside the desktop captured-SMTP feature.
