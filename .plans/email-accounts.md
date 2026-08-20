# Pathway Mail — connected mailboxes

Status: design in progress. Successor to `local-smtp-capture.md`, which explicitly deferred this
work: *"The Gmail side keeps rendering its placeholder. Direct mailbox integration (Gmail,
Outlook, self-hosted) is separate work and will land in the Email settings group this plan
creates."*

Revision 4 — 2026-08-21. Corey ruled out BYO OAuth and required instant cross-device sync, then
asked whether an environment should host the mail connection so its agent CLIs can do the agentic
work. Answer: split by availability requirement — the relay ingests, the environment thinks. Bytes
go to UploadThing, which is already wired for issue attachments.

## Context

Pathway captures dev mail (`apps/server/src/email/*`, ~3.5k lines, SMTP sink → `mail.sqlite` → a
real two-pane client at `/email`). Next to the "Local SMTP" toggle sits a "Gmail" half that is a
`<p>` reading *"Connecting a Gmail mailbox is not available yet."*

This plan makes that half real: sign in with Google, read your mail in a Superhuman-shaped
client on every device at once, and put a Pathway agent on top that triages Prioritized vs Noise,
escalates anything that looks like an outage or a deadline, drafts replies in your voice, and
answers questions about a sender with their full history in context.

The valuable half is not the mail client — it is that Pathway already has agents, threads,
projects, issues and an orchestration engine sitting next to the inbox. Nobody else can turn an
alert email into a running agent thread in one hop.

---

## The shape, in one paragraph

A **cloud sync worker** in the existing Cloudflare relay holds each user's Google refresh token,
receives Gmail push notifications, parses mail, and writes it into Convex — with attachment and
raw-MIME bytes going to **UploadThing**, the byte store already used for issue attachments. Every
device is a **pure reader of the Convex change feed**; no device ever talks to Gmail. There is
exactly one syncer per account, so there are no double-ups, no races, and no "streaming it in
after it connects": a new device opens and the mail is already there.

**Ingest is the only thing that lives in the cloud.** Everything agentic — LLM triage on the
ambiguous margin, drafting, polish, deep analysis, launched threads — is dispatched to the user's
**environment** over the existing `environmentCommands` table and runs on their own provider CLIs.
Ingest must be always-on and is small, deterministic and cheap. Agentic work can be opportunistic
and is neither. Splitting them that way means Pathway pays essentially nothing per email while
mail still arrives instantly on a phone with every laptop shut.

---

## What already exists (reuse, do not rebuild)

| Need | Existing thing | Path |
|---|---|---|
| Two-pane client, resizable, virtualized | `EmailView` + `EmailMessageList` (LegendList) | `apps/web/src/components/email/EmailView.tsx` |
| Sandboxed HTML, remote-image blocking, trusted senders | `EmailReadingPane` + `buildEmailPreviewDocument` | `components/email/EmailReadingPane.tsx` |
| "All X" dropdown (`null` = all, sentinel inside `Select`) | `EmailEnvironmentSelect` | `components/email/EmailSidebar.tsx:74` |
| Segmented toggle with sliding pill | `EmailSourceToggle` | `components/email/EmailSidebar.tsx:123` |
| Right-hand agent panel with entity context | `IssuesAssistantPanel` + `rightPanelStore` | `components/issues/IssuesAssistantPanel.tsx` |
| Entity context → prompt | `lib/issueContext.ts` → XML block + composer chips | `apps/web/src/lib/issueContext.ts:69` |
| Mail→agent-thread launch, rate limited, loop detected | `EmailTriggerService` | `apps/server/src/email/EmailTriggerService.ts:435` |
| One-shot structured LLM calls | `TextGeneration` (`claude -p --output-format json`) | `apps/server/src/textGeneration/TextGeneration.ts` |
| MIME parse / send | `mailparser`, `nodemailer` (already deps) | `apps/server/package.json` |
| SPF/DKIM/DMARC header parsing | `DeliverabilityAnalyzer` | `apps/server/src/email/DeliverabilityAnalyzer.ts` |
| **Cloudflare Worker + Queues + DLQ + cron, all Effect-based** | `infra/relay` (Alchemy-deployed) | `infra/relay/src/worker.ts:277,313`, `src/queues.ts` |
| **Authorized direct-to-UploadThing byte store** | `issueAttachments.ts` (`prepareUpload`/`verifyUpload`, swappable client seam) | `packages/backend/convex/issueAttachments.ts:82,127` |
| Browser upload client + pending→finalized→ready GC | `issueAttachmentClient.ts` | `apps/web/src/cloud/issueAttachmentClient.ts` |
| **Durable dispatch to an environment, claimed once, survives offline** | `environmentCommands` | `packages/backend/convex/schema.ts:505` |
| **Convex-backed relay persistence with DPoP auth** | `relayPersistence.ts` + `relay*` tables | `packages/backend/convex/schema.ts:977-1123` |
| Company sync feed, tombstones, permissions | `SYNC_ENTITY_KINDS` | `packages/contracts/src/cloudSync.ts:244` |
| OS-keyring encryption incl. Linux backend selection | `ElectronSafeStorage` + `linuxSecretStorage.ts` | `apps/desktop/src/electron/ElectronSafeStorage.ts` |
| Personal-thing-that-can-be-shared | `issueViews` (`private \| teams \| company`) | `packages/backend/convex/schema.ts:1577` |

The relay already has Queues with a dead-letter queue, cron triggers (`*/5 * * * *`), an
Effect-based Worker runtime and Convex persistence. The mail sync worker is a new module inside a
stack that already exists, not new infrastructure.

---

## Decisions

### 1. Sign in with Google. Pathway owns the OAuth client.

BYO credentials are dropped. The flow is the one everybody already knows: click **Connect Gmail**,
land on Google's consent screen, approve, come back, mail starts arriving. No Google Cloud
project, no console, no pasted strings, for developers or anyone else.

**This puts Google's verification gate on the critical path, and it cannot be engineered around.**
The facts, from Google's own docs and current assessor pricing:

- `gmail.modify` — which a real client needs — is a **restricted** scope. Restricted scopes require
  OAuth App Verification, and *"if storing or transmitting restricted scope data on servers, a
  security assessment is mandatory."* We are doing exactly that, deliberately (decision 2).
- The assessment is **CASA**, run by a Google-empanelled assessor: a DAST scan against the
  **production** app plus a self-assessment questionnaire. Self-serve Tier 2 lab fees currently run
  roughly **$540–$1,000**, with some assessors charging $3,000+.
- End-to-end timeline, CASA plus Google's own review: **4–12+ weeks** from first submission.
- It **recurs annually** — reverification and a fresh assessment *"at least every 12 months after
  your assessor's Letter of Assessment (LOA) approval date."*
- Least privilege is reviewed. Request `gmail.modify` and nothing broader. Do **not** request
  `https://mail.google.com/`, which is the full-IMAP scope and draws the heaviest scrutiny.

Two consequences for sequencing:

**CASA scans production, so verification cannot start until the thing is deployed.** The order is
build → deploy → submit → ship publicly. Verification is not a parallel track that can begin at
approval; it begins when Stage 1 is live.

**Dogfooding is unblocked the whole time.** Google exempts personal-use apps — *"if the user is the
only user of your app or if your app is used by only a few users… known personally to you."* Corey
and the team can use this from day one. The cost is that an app in **Testing** publishing status
gets *"a refresh token expiring in 7 days"*, so internal users re-consent weekly until
verification clears. Annoying, survivable, and worth building a one-click reconnect for since
reauth is a permanent part of this feature's life anyway.

**Desktop flow.** Loopback redirect with PKCE, following `CliTokenManager.ts` — which already does
loopback `NodeHttpServer` on a random port, PKCE/state, a 10-minute `Deferred` timeout, refresh 5
minutes early, and a terminal fallback for headless. Google is explicit that for installed apps
*"the client secret is obviously not treated as a secret"*, so embedding it is expected, not a
leak. The authorization code is exchanged **by the relay, not the client**, so the refresh token
never touches the user's disk.

### 2. Sync runs in the cloud. Devices only read.

Corey's requirement: instant across all devices, no double-ups, no streaming-in after connect, and
it must hold when the mobile app arrives and when multiple desktops are signed in.

That rules out device-side sync. If two desktops both sync one Gmail account they duplicate the
API quota, race each other's Convex writes, and disagree about triage. And any design where a
designated machine syncs fails the moment that machine is shut — which is most of the time.

So: **exactly one syncer per account, and it lives in the relay.**

```
Gmail ──users.watch──▶ Cloud Pub/Sub ──push──▶ relay Worker (/mail/notify)
                                                    │
                                            enqueue │ Cloudflare Queue
                                                    ▼
                                          mail-sync consumer
                                       (history.list → messages.get)
                                                    │
                            ┌───────────────────────┼───────────────────┐
                            ▼                       ▼                   ▼
                    Convex (metadata,      UploadThing (private:   environmentCommands
                    bodies, threads,        raw .eml, attachments)  (agentic work →
                    triage, sender graph)                            user's own CLIs)
                            │
                            ▼
                    company change feed ──▶ desktop / web / mobile (readers)
```

**Why push works here and did not before.** `users.watch` → Pub/Sub needs a public HTTPS endpoint
to deliver to. A laptop does not have one. The relay Worker does. That is what makes this
genuinely instant — seconds, not a poll interval.

The Gmail push contract, and what it forces:
- Payload is only `{emailAddress, historyId}` — a nudge, not the data. The worker still calls
  `history.list`.
- `watch` **must be re-armed at least every 7 days**; the docs recommend daily. The existing
  `*/5 * * * *` cron (`worker.ts:313`) grows a renewal sweep.
- Delivery is capped at **one event per second per user**, excess is **dropped**, and Google
  explicitly says notifications are not guaranteed and to **keep fallback polling**. So a slow
  reconcile poll stays, permanently, as a backstop — not as an interim measure.
- `history.list` returns **HTTP 404 once `startHistoryId` ages out** of a window that is *"typically
  at least one week"*. So `resync_required` is a first-class state with a visible account status,
  not a caught error. Getting this wrong is the single most common way mail clients silently stop
  receiving mail.

**Backfill.** A mature mailbox is 100–200k messages and cannot be one Worker invocation. Backfill
fans out over the existing Queue — one queue message per page of `messages.list` — with the DLQ
already wired at `worker.ts:284`. Progress is a visible per-account state so a new user watches
their inbox fill rather than staring at a spinner.

**Quota is now shared.** Every user runs against *Pathway's* Gmail API project quota, not their
own. A 200k-message backfill is on the order of 10^6 quota units; a thousand users backfilling at
once approaches the per-project daily ceiling. Needs a quota increase request to Google before
launch, plus a throttled, fair-shared backfill scheduler. This is a real scaling item, not a
footnote.

**What happens to the local server.** Mail no longer needs an environment at all. `mailbox.sqlite`
survives only as an **optional offline read cache** hydrated from the change feed — never a sync
source, never authoritative. This is a genuine simplification over revision 2.

### 3. Bytes go to UploadThing. Metadata goes to Convex.

Corey: use UploadThing — it is already wired — and scope every upload
`companyId/<assetType>/<asset>`. Agreed; revision 3's R2 recommendation is withdrawn. The house
pattern already exists and is good: `packages/backend/convex/issueAttachments.ts` owns
authorization, identity and metadata while UploadThing is *only* the byte store, with a swappable
`UploadThingClient` seam (`:82`) so no test needs a token or the network, a REST client that avoids
a Node action module (`:127`), and a `pending → finalized → ready` state machine with GC for
abandoned uploads. `apps/web/src/cloud/issueAttachmentClient.ts` is the direct-to-UploadThing
browser half. Mail reuses all of it.

**Scoping.** UploadThing generates its own opaque `key`; the addressable, meaningful identifier is
`customId`, which `prepareUpload` already accepts (`issueAttachments.ts:141`) and which
`deleteFiles` / `renameFiles` / `updateACL` accept via `keyType`. So the convention lands there:

```
<companyId>/email/<accountId>/<messageId>/<attachmentId>
<companyId>/email/<accountId>/<messageId>/raw.eml
<companyId>/issue/<issueId>/<attachmentId>          # existing rows backfilled
```

Convex holds the row — `customId`, UploadThing key, filename, mime type, byte size, checksum — so
the UI renders an attachment list with no byte fetch at all.

> **Security change, and it matters.** Issue attachments today are uploaded with
> `acl: "public-read"` and served from `https://utfs.io/f/<key>` (`issueAttachments.ts:143,157`).
> For issue attachments behind an unguessable key that is arguably tolerable. For **email** it is
> not — these are strangers' bank statements, contracts and medical letters, and a URL that leaks
> into a log, a referrer or a support ticket is a permanent unauthenticated read.
>
> Mail attachments upload with **`acl: "private"`**, and clients fetch them through a Convex-
> authorized call that returns a short-lived `generateSignedURL()` (the local variant — it makes no
> UploadThing API request, so no added latency; expiry caps at 7 days, we use minutes). Whether the
> existing issue attachments should also move to private ACL is a separate call, but it is the same
> hole with a smaller blast radius.

**What lives where.** Convex documents cap at **1 MiB**, so the line is drawn on size, not type:

| Data | Home | Reason |
|---|---|---|
| Account, folder, thread, message metadata, snippet | Convex, in the change feed | Small; needed for every list render on every device |
| Body text + sanitized HTML | Convex, capped ~750 KiB | Fits the 1 MiB doc limit for effectively all real mail |
| Triage verdict, sender stats, sender rules | Convex, in the change feed | The knowledge graph must follow the user across devices |
| Bodies over cap, raw `.eml` | **UploadThing**, private | Rare, large, not worth chunking across documents |
| Attachments | **UploadThing**, private, `customId` as above | Reachable from every device; deleted with the account |

**Sync window.** Syncing every user's full archive into Convex is real recurring money for mail
nobody opens. Default: the trailing **12 months**, plus every thread with recent activity. Older
mail stays in Gmail and is reachable by on-demand search. Configurable, with the cost stated in
Settings. A cost dial, and Corey's to set.

### 4. Refresh tokens: envelope encryption, and this is what CASA will look at

Refresh tokens now live in Pathway's cloud rather than on the user's disk. They are the highest-
value secret in the system and the first thing an assessor will ask about.

- Per-account **DEK**, random, used to AES-256-GCM the token.
- DEK wrapped by a **KEK** held in Cloudflare Secrets, never in Convex, never in the repo.
- Only the wrapped DEK plus ciphertext land in Convex, in a `mailCredentials` table with **no read
  path from the company change feed** — the sync worker reads it, nothing else does, ever.
- KEK rotation re-wraps DEKs without touching ciphertext.
- Disconnecting an account revokes the grant at Google, then deletes the credential row, the Convex
  documents, and the UploadThing objects.

**The environment-side secret store still gets fixed.** `ServerSecretStore` writes plaintext at
`chmod 0600` (`ServerSecretStore.ts:157,190,222`) and holds `cloud-cli-oauth-token`,
`slack-bot-token` and `cloud-relay-environment-credential`. Mail no longer adds to that pile, but
the pile is still there, and an assessor scanning the desktop app will find it. It gains a
pluggable `SecretCipher`:

- **Desktop-hosted server** → `ElectronSafeStorage`, which already exists and ships
  (`DesktopSavedEnvironments.ts:441`, `DesktopConnectionCatalogStore.ts:382`), including the hard
  part — Chromium's Linux backend selection in `linuxSecretStorage.ts`, with its documented rule
  that forcing `gnome-libsecret` beats falling through to *"basic text, which is barely encryption
  at all"*.
- **Headless server** → OS keyring via CLI (macOS `security`, Windows DPAPI, Linux libsecret),
  falling back to AES-256-GCM under a `PATHWAY_SECRET_PASSPHRASE`-derived key.
- **No silent plaintext fallback.** Writes fail loudly and Diagnostics says why. A credential store
  that quietly degrades is worse than one that refuses, because nobody finds out until the breach.

A version byte plus cipher tag lets existing plaintext secrets be recognised and re-sealed in place
on first read.

### 5. `EmailStore` full-table scans — fixed here

`list` (`:507`), `idsForScope` (`:574`), `applyRetention` (`:609`) and `allMessages` (`:636`) all
`SELECT` the whole table and filter in JavaScript; only `analytics` builds real `WHERE` clauses.

All four move to real SQL with keyset pagination on the existing
`email_messages_inbox_received_idx(project_id, received_at DESC, id DESC)`. `allMessages` becomes
`messagesSince(watermark)`.

That last one also fixes the capture publisher. **It already pushes** —
`capturedEmailPublisher.ts:199-213` merges `store.stored` with a 15s tick, so dev mail goes up the
instant it lands. The waste is that the tick's `reconcile` calls `store.allMessages` (`:160`),
decoding every row and re-publishing all of them at concurrency 4, forever. An in-memory identity
map suppresses the network calls, so it burns local CPU and I/O rather than Convex writes — but it
is continuous pointless work and it dies at real volume. Watermark the reconcile on `stored_ms` and
drop the tick to a 5-minute backstop.

### 6. OS notifications — built here

No `new Notification(...)` exists anywhere in `apps/desktop` or `apps/web` today.

- **Electron main** — a `DesktopNotifications` Effect service wrapping Electron `Notification`,
  shaped like the existing `ElectronSafeStorage` service (typed errors, availability check,
  `Layer`). Click-to-focus-and-open-thread, macOS permission state, per-platform quirks.
- **IPC + renderer** — a typed channel through the existing local-API bridge (the one behind
  `readLocalApi().contextMenu.show(...)` at `EmailView.tsx:526`), so the web bundle calls one
  function and gets a native notification on desktop, a no-op in the browser.
- **Web fallback** — the Notification API where permitted, otherwise the in-app toast.
- **Escalation ladder**: in-app toast → OS notification → launched agent thread.

Because alerts are triggered by the cloud worker and delivered through the change feed, an alert
reaches whichever devices are open — and is already waiting on the ones that are not.

Reverse states, per AGENTS.md: dismiss, mute sender, mute thread, per-account mute, master switch.

### 7. Contacts move to Convex

Contacts today are `useLocalStorage("pathway:contacts")` (`ContactsView.tsx:37`) — one browser, one
machine, no sharing, no server. They become first-class company data.

```ts
contacts: defineTable({
  id: domainId,
  companyId: v.id("companies"),
  ownerMembershipId: v.id("memberships"),
  visibility: v.union(v.literal("private"), v.literal("teams"), v.literal("company")),
  teamIds: v.array(domainId),          // empty = company-wide, matching the issue rule
  name, email, phone, role, organization, notes, favorite,
  source: v.union(v.literal("manual"), v.literal("mail"), v.literal("import")),
  createdAt, updatedAt, version,
})
```

Same `private | teams | company` triple as `issueViews` (`schema.ts:1577`), gated by the existing
`COMPANY_PERMISSIONS` through `hasRecordPermission` / `permittedTeamIds`. New `SYNC_ENTITY_KINDS`
literal `"contact"`, new `packages/contracts/src/contacts.ts` and `convex/contacts.ts`,
`ContactsView` rewritten onto the sync replica. Existing localStorage contacts are offered as a
one-time import, then the key is cleared.

"Add sender as contact" from the mail Sender panel writes here, defaulting to `private`.

### 8. The environment does the thinking. The relay only ingests.

Corey asked whether an environment should host the mail connection and push to Convex, so its
agent CLIs can do the agentic work. The margin argument is strong and the answer is **yes for the
agentic half, no for ingest** — because the two halves have opposite availability requirements.

**Why ingest cannot live in an environment.** A laptop is shut most of the time. If ingest lives
there, mail stops arriving on your phone, and then floods in when the laptop wakes — which is
precisely the "stream it in after it connects" Corey ruled out. It also reintroduces the
double-ups problem: with several environments linked, one has to be designated the mail host, with
failover and a split-brain story when two of them claim it. And it buys nothing on compliance:
message bodies still land in Convex, so Pathway is still *storing restricted-scope data on
servers*, and the CASA assessment is mandatory either way. Paying the availability cost without
the compliance saving is the worst of both.

(Worth noting the proposal is not disqualified on the push-endpoint ground I would have expected.
Linked environments **do** get a public HTTPS hostname through the Cloudflare tunnel —
`relayManagedEndpointAllocations` (`schema.ts:1048`) — so Pub/Sub could in principle deliver
straight to one. The objection is availability and designation, not reachability. But tunnel
allocations are quota'd per cloud user via `relayManagedTunnelLimits`, and coupling mail ingest to
that quota is its own mess.)

**Why agentic work belongs there.** Drafting a reply, polishing, deep thread analysis, launching a
thread — none of it needs to happen while every device is off. It is either user-initiated or
enrichment that can land late. And the dispatch machinery already exists:
`environmentCommands` (`schema.ts:505`) is durable, `claimed exactly once` under a
`claimGeneration` lease, carries `targetEnvironmentId`, and its own doc comment says *"A command
survives the target being offline."* Mail work becomes new command kinds alongside `startThread` /
`sendMessage`, queued when nothing is online, claimed the moment something is.

**So the split is:**

| Job | Where | Why |
|---|---|---|
| Fetch, parse, store, deterministic triage | Relay Worker | Must be always-on; no model call; cheap |
| Deterministic urgency signals | Relay Worker | An outage alert must fire with every device shut |
| Ambiguous urgency, the small hard tail | Relay Worker, `claude-haiku-4-5` | Fractions of a cent; the alert is the whole point |
| Bucket resolution on the ambiguous band | Environment, via `environmentCommands` | Can land late; runs on the user's CLI |
| Draft, polish, shorten, rewrite | Environment | User-initiated; runs on the user's CLI |
| Deep thread/sender analysis, launched threads | Environment | Already how `EmailTriggerService` works |

This resolves revision 3's open question about who pays. **Pathway pays for a haiku call on a thin
slice of ambiguous-urgency mail and nothing else.** Everything expensive runs on the user's own
provider subscription, which is both cheaper and a better privacy story.

**Stage 1 triage — deterministic, in the relay, no model.** Runs on every message at ingest:

- **Sender relationship** from the sender graph — have you replied to this address, how often, how
  recently. Replied-to is by far the strongest signal and it is free.
- **Already in the thread** — a reply on a thread you participate in is prioritized, no scoring.
- **Bulk headers** — `List-Unsubscribe`, `List-Id`, `Precedence: bulk`, `Auto-Submitted`.
- **Auth results** — SPF/DKIM/DMARC via the existing `DeliverabilityAnalyzer` logic.
- **Addressing shape** — direct `To:` vs. one of 200 `Cc:`.
- **Contact / workspace membership** — sender is a contact or a member of your company.
- **Known alerting senders** — PagerDuty, Datadog, Statuspage, Sentry, GitHub Actions, plus
  `X-Priority` and subject patterns. This is where most real urgency actually is, and it costs
  nothing.

Output `{bucket, score, confidence}`, written to Convex immediately so every device sees it at
once. Anything the deterministic pass cannot settle is queued for the environment; anything it
flags as *possibly* urgent but is unsure about gets the one cheap cloud call.

**The knowledge graph stays per-user and deterministic.** Corrections are the training signal:
Noise→Prioritized writes a sender rule and bumps sender stats, both synced. No shared model, no
cross-tenant learning — which is also what Google requires, since using the data to train anything
*"beyond that specific user's personalized model"* is prohibited.

### 9. Sharing: owner-scoped by default, explicit snapshot to share

The local server has no concept of a user; `EmailInboxScope` is a filter, not a boundary. All
multi-user semantics live in Convex, and mail is now entirely a Convex citizen, which makes this
cleaner than in revision 2.

**Owner-scoped sync.** `mailAccounts` / `mailThreads` / `mailMessages` carry `companyId` **and**
`ownerMembershipId`, and every query filters on the caller's own membership. Nobody else reads it
regardless of permissions, and there is no company-admin read path — an admin who can silently read
employee mail is a liability, not a feature.

**Explicit share** writes a separate `sharedMailThreads` record carrying a **snapshot**,
`sharedByMembershipId`, `visibility: teams | company`, `teamIds`, `membershipIds`, an optional
note, and `revokedAt`. A snapshot rather than a live mirror because: consent is bounded to the
thread as it stood; the mailbox is reachable only through the owner's grant; deleting the share
actually deletes the data; and it is one auditable row. Recipients see it under **Shared with me**,
read-only. Replying is not offered — the reply would come from the sharer's mailbox. They comment
instead, in the right-hand agent panel where discussion already lives.

**Agents** see a mailbox only when the account's `agent_access` is raised from its `none` default,
and a shared thread only through the share record.

---

## UI

### Navigation

`EmailSourceToggle` becomes **Capture | Mail**, and its state moves from component-local `useState`
(`EmailSidebar.tsx:166`) into the search params alongside every other piece of email view state —
it is currently the only exception, so the toggle silently resets on navigation.

In **Mail** mode:

- **Account select** — `EmailEnvironmentSelect` copied in shape: `null` = "All accounts",
  `ALL_ACCOUNTS_VALUE` sentinel only inside the `Select`, trigger renders `?? "All accounts"`, with
  a trailing "Add mailbox…" row via the `BranchToolbarEnvironmentSelector` sentinel idiom
  (`:112`). Replaces the environments select, which is meaningless for cloud-synced mailboxes.
- **Priority | Noise | All** — three-way segmented toggle. Same `ToggleGroup` markup as
  `EmailSourceToggle`, with the sliding pill generalized from `translate-x-full` to a
  `translate-x-{0,full,200%}` step over `grid-cols-3` and width `w-[calc(33.333%-2px)]`. Unread
  count per segment. State in the search params.
- Folder rows (Inbox, Sent, Drafts, Archive), then **Shared with me**.

"All accounts" merges across accounts on `received_ms` with keyset pagination on the composite key.

### Main area

`EmailView`'s two-pane shell with the reading pane replaced by a **conversation view**: messages
stacked chronologically, collapsed to sender + snippet + time, expanding in place, quoted trailer
behind a "…" affordance. Each message keeps the existing sandboxed `srcdoc` iframe, strict CSP and
remote-image blocking — that machinery is done and correct, including per-message grants and the
replicated trusted-sender list. Existing Preview / Metadata / Deliverability / Raw tabs stay per
message.

Reply composer inline at the foot. Agent actions — **Draft reply**, **Polish**, **Shorten**, **Make
warmer** — via new `generateMailReply` / `polishMailDraft` operations shaped like
`generateCommitMessage` (JSON schema in, decoded struct out), prompts in a new `MailPrompts.ts`.
Context is the thread plus your prior replies to this sender, so drafts match your voice.

**Nothing auto-sends.** Drafts are `mail_outbox` rows requiring an explicit send. Sending goes
through the sync worker via the Gmail API, so it threads correctly and lands in Sent — and works
from a phone with no desktop running.

### Right panel

A new `mail` surface kind in `rightPanelStore`, rendered by a `MailAssistantPanel` built from
`IssuesAssistantPanel` (same `RightPanelTabs` chrome, same `ChatView presentation="panel"`, same
inline-portal/sheet switch):

- **Ask** — a `ChatView` with the current message as context. New `lib/mailContext.ts` producing
  `<mail_context><message id=… thread=… from=… subject=… /></mail_context>`, mirroring
  `lib/issueContext.ts:69`, with removable composer chips.
- **Sender** — identity, sender stats, every thread with this person, attachments they have sent,
  and **Add to contacts**.

### Settings

New page at `/settings/mail` (`/settings/email` stays as dev-capture settings). Checklist:
`SettingsPath` → `SETTINGS_SECTION_LABELS` → the existing **Email** `SETTINGS_NAV_GROUPS` group →
`SETTINGS_SECTION_ICONS` → `SETTINGS_SEARCH_ITEMS` → `routes/settings.mail.tsx` +
`components/settings/MailSettingsPanel.tsx`.

Contents: connected accounts with live sync status, backfill progress and one-click reconnect; sync
window with its cost stated; triage on/off + model; the AI consent record; alert delivery + master
mute; per-account agent access (`none | read | read-write`, default `none`); disconnect (which
revokes at Google and deletes everything).

---

## Contracts, scopes, MCP

Wire types in `packages/contracts/src/mail.ts`. New `SYNC_ENTITY_KINDS` literals: `mailAccount`,
`mailThread`, `mailMessage`, `mailTriage`, `mailSenderRule`, `sharedMailThread`, `contact` — each
with a `Sync…Payload`. Relay endpoints join the existing `RelayApi` (`packages/contracts/src/relay.ts`)
under the existing DPoP client identities.

Any environment-side RPCs added still need a row in `RpcAuthorization.ts` — the table is
`satisfies Record<WsRpcMethod, …>`, so omitting one is a compile error.

MCP: extend `apps/server/src/mcp/toolkits/email/` rather than adding a toolkit — `email_list` /
`email_get` gain an `account` scope, plus `mail_search` and `mail_draft_reply`. Real mail stays
invisible to agents until `agent_access` is raised from `none`.

### Disclosure

Google's Limited Use rules permit sending mail content to a third-party model only where the
feature is prominent in the UI, disclosed, consented to, and the third party does not train on it.
With cloud triage this needs to be exact, and it will be read by an assessor: the consent step
names what leaves Google (subject, sender, body text of ambiguous and prioritized messages), where
it goes (Anthropic's API under Pathway's zero-retention terms), and what does not happen (no shared
model, no human review, no training). Triage is off until accepted, revocable in Settings → Mail.

---

## Staging

**Stage 0 — foundations.** Independent of Google, all independently valuable:
1. `SecretCipher` + real encryption for every existing environment secret, desktop and headless.
2. `EmailStore` full-table scans → real SQL; `allMessages` → `messagesSince(watermark)`; watermarked
   publisher reconcile on a 5-minute backstop.
3. `DesktopNotifications` service + IPC bridge + web fallback.
4. Contacts → Convex.
5. Mail byte store on UploadThing: `customId` scoping convention, **private ACL**, and a
   Convex-authorized `generateSignedURL()` fetch path, extending `issueAttachments.ts`.
*Exit: a secret round-trips sealed on macOS/Windows/Linux/headless; the capture reconcile no longer
touches unchanged rows; a native notification fires on all three platforms; contacts appear on a
second machine; a private byte round-trips through UploadThing via a short-lived signed URL, and is
unreachable without one.*

**Stage 1 — Gmail, read-only, cloud-synced.** GCP project, Pub/Sub topic, OAuth client. Relay
`mail-sync` Worker: `watch` + renewal cron, `/mail/notify` push endpoint, queue-fanned backfill,
`history.list` partial sync with 404→resync, Convex writes, UploadThing bytes. Client reads the change feed.
Conversation view, search, attachments. No AI.
*Exit: a real inbox reads identically on two devices with no local server running; new mail appears
within seconds of arrival; a forced `historyId` 404 recovers by resync; backfill of a 50k mailbox
completes with visible progress and no DLQ entries.*

**Stage 1.5 — verification.** Deploy to production, submit for CASA + OAuth App Verification,
request the Gmail quota increase. **4–12+ weeks, and it gates general availability, not
development.** Internal dogfooding continues under the personal-use exemption throughout, with
weekly re-consent.

**Stage 2 — triage.** Sender graph, deterministic classifier, Priority/Noise/All toggle,
corrections writing sender rules, all synced.
*Exit: accuracy measured against a hand-labelled fixture set; a correction on one device changes
classification on another.*

**Stage 3 — the agent.** Model escalation, urgency assessment, the full alert ladder, right-hand
assistant panel, drafts and polish, sending.
*Exit: a seeded outage email produces a native notification on a device that was closed when it
arrived, and a launched thread; rate limiter and loop detector both trip under test.*

**Stage 4 — more providers.** Microsoft Graph (per-folder `deltaLink`; its own verification story),
generic IMAP/SMTP.
*Exit: the adapter interface absorbed both without changes to storage or triage.*

**Stage 5 — sharing.** `sharedMailThreads`, share sheet, revocation, Shared-with-me, permissions.

### Out of scope, deliberately

- **The Pathway hosted mail service.** Inbound MX, outbound relay, per-domain DKIM, domain
  verification UX, deliverability reputation management. A product, not a feature; reputation is a
  full-time operational job. `infra/` would gain a `mailgw` Worker alongside the relay.
- **Calendar integration.** `/calendar` is an 18-line placeholder with no data model. The message
  model carries `text/calendar` parts so invites survive round-trip; nothing reads them yet.
- **Replying to a shared thread.** The reply would come from the sharer's mailbox. Comment instead.
- **Mobile UI.** `apps/mobile` was deleted in `f0fc94055`. But the architecture here is what makes
  mobile cheap when it returns: a phone is just another change-feed reader, and the existing
  `AgentAwarenessRelay` → APNs path already delivers push.

---

## Verification

Per AGENTS.md: focused tests for the scope changed, no repo-wide runs, and **no test that needs a
timeout to pass** — wait on receipts and worker drains, never sleeps.

- **Pure logic, colocated `*.logic.test.ts`** — triage scoring against hand-labelled fixtures;
  cursor advance/invalidate/resync transitions; thread grouping from `References`/`In-Reply-To`;
  quoted-trailer detection; the three-way toggle's pill offset.
- **Sync worker** — fixture-driven `history.list` responses including the 404 path, duplicate push
  delivery (idempotency), out-of-order `historyId`, and a dropped notification recovered by the
  reconcile poll. No network; the Gmail client is an interface with a test layer, following the
  `EmailProjectCatalog.layerTest` precedent (`:49`).
- **Secret cipher** — round-trip per platform, refusal when no backend exists, in-place migration of
  an existing plaintext secret. Extend `ServerSecretStore.test.ts`.
- **Store** — keyset pagination at page boundaries, and a regression asserting `list` issues a
  bounded query rather than a full scan.
- **Publisher** — extend `capturedEmailPublisher.test.ts`: reconcile after a watermark advance
  touches only new rows.
- **Convex permissions** — pure tests in `packages/backend/src/` for owner-scoped mail reads, share
  visibility, and contact visibility across `private | teams | company`.
- **Trigger/alert** — extend `EmailTriggerService.test.ts` (267 lines, already covers rate limiting
  and loop detection) with the `urgency` rule kind.
- **End to end** — `test-pathway-app` against a seeded Convex: connect a fake account, sync,
  classify, correct, alert, share, draft a reply, and confirm a second client converges.

## Open decisions

1. **Sync window default.** 12 months proposed. Larger is friendlier and costs real Convex money.
2. **Whether existing issue attachments also move to private ACL.** Same hole, smaller blast
   radius. Cheap to do while the mail path is being built; awkward later.
3. **Whether to start the GCP project + Pub/Sub topic now.** A Stage 1 prerequisite with no code
   dependency, so it can begin immediately.
4. **How much Superhuman lands in v1.** Snooze, send-later, read receipts, split inbox and
   command-K mail actions are absent above. The repo has `CommandPalette` and a `keybindings.ts`
   registry, so the keyboard-first half is cheaper than it looks.
