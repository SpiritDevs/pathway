# Shared Contacts and Time Tracker

Contacts are company-owned Convex records. Active human members may read a company's contact directory. The existing `projects.manage` permission controls contact creation, editing, import and deletion, consistent with the shared email-tag catalog. Contact revisions reject stale edits; a request ID makes a lost-response retry safe. Deleted rows remain tombstones so retrying an old import cannot resurrect them.

Time sessions belong to the authenticated user across their companies and devices. An indexed read of that user's running sessions and the insertion occur in one Convex mutation, so two devices cannot independently start a timer. Start IDs are immutable retry identities. Stop targets an exact session ID, so a delayed stop cannot stop a newer session. Repeating a start after its original session stopped returns the original session without starting it again. Duration is computed by the server clock.

## Native integration

Construct `PathwayContactsModel(request:subscribe:)` and `PathwayTimeModel(request:subscribe:)` using the authenticated cloud request and `AsyncThrowingStream<JSONValue, Error>` subscription adapter. Render `PathwayContactsView(model:companies:)` and `PathwayTimeView(model:accountID:projects:)`. Time Tracker's account ID must be the signed-in Clerk user ID because pending commands are stored beneath an account-specific key. Subscription errors clear private displayed data.

Native and web timer clients persist a command identity before sending it, retain uncertain failures, and expose explicit retry/discard controls. Discard removes the local retry; it does not undo a server-accepted transition. No timer is presented as running merely because a local start was queued.

## Desktop migration

The previous `pathway:contacts` and `pathway:time-tracker` entries remain intact. They are read only as an import source. Contacts require explicit confirmation naming the destination workspace and explaining its shared visibility. Timer import explicitly targets the signed-in user's account. A previously active local timer is imported as a completed historical session ending when Import was chosen; it never silently starts a server timer. Import batches contain at most 200 entries, and repeated imports use deterministic IDs scoped to the source user.

## Verification and deployment

Seven backend tests cover authority, optimistic-concurrency conflicts, import retries/deletion, simultaneous cross-device starts, user isolation, stale stops and atomic rejection of malformed imports. Four native model tests cover privacy on workspace change and account-scoped durable retry identities, including malformed stored retries. Existing contact/timer helper tests remain green. New native files typecheck against iOS and visionOS Simulator SDKs; focused backend and web TypeScript checks are clean.

The schema and functions must be deployed before these cloud workflows are operational. No deployment, generated API update or browser/device validation is implied by these source checks. Contacts use direct authenticated subscriptions rather than company-sync entity kinds; timer sessions likewise stay out of the company replica because they are private to a user.

## Bounded timer history

`timeTracking:listMine` returns 50 completed sessions, `cursor`, `isDone`, and the active timer. The running timer uses a separate user/state index, so even a long-running session is always returned. Completed history uses the user/state/completion-date index; `since` selects a completion-date boundary without scanning older or deleted sessions. Clients can load every page. A refreshed live first page invalidates older loaded pages and outstanding page requests; users can refresh history explicitly to revisit older snapshots.

`timeTracking:recentTotals` reads only sessions completed since the current local week's boundary, up to 2,001 rows. At more than 2,000 rows it returns `complete: false`, and both clients display an unavailable summary rather than a truncated total. History remains fully pageable. The query returns full session durations for the existing desktop day/week semantics and boundary-clipped durations for the existing native semantics. Native All sessions explicitly labels its sum as the loaded sessions total.

`timeTrackingPagination.test.ts` covers complete paging, user isolation, older running timers, completion-date filtering, overnight summary semantics, and the explicit summary ceiling. `PathwayTimePaginationTests.swift` covers page merging, retained period arguments, account clearing, and refresh races. Deploy the added `by_user_and_state_and_stopped_at` index with these query changes before releasing the updated clients.
