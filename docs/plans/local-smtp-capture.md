# Local SMTP capture

Status: agreed design, not yet implemented.
Depends on [MCP v2 migration](./mcp-v2-migration.md), which lands first.

A MailHog-style SMTP sink built into the Pathway server. Local apps point their
mailer at it, captured mail shows up in the Email view, and agents read it over
MCP — so an agent driving a login flow can wait for the verification email and
pull the code out of it, and be told the moment it arrives rather than polling
for it.

This document is the outcome of a design interview. It records what was decided
and, where a decision was close, why the other option lost.

## Scope

In scope: the SMTP listener, capture storage, project routing, the Email view
(inbox, preview, metadata, deliverability, raw), 2FA detection and toasts,
aggregate analytics, a central Email settings section, MCP tools with push
notification, mail-triggered agent runs, and restoring project settings into the
Settings view.

Out of scope, deliberately:

- **Relaying.** The listener is a pure sink. It never forwards to a real MTA.
  This is what makes binding all interfaces defensible — an open relay on
  `0.0.0.0` is a different risk class entirely.
- **Outbound HTTP webhooks.** Cut deliberately. MCP v2 has no webhook mechanism
  at all — push is `subscriptions/listen` and `notifications/tasks` — and the
  agent use case is fully served by those plus the internal trigger path. It
  also avoids Pathway making arbitrary outbound requests on inbound-mail
  trigger, which is its own SSRF-shaped concern. External consumers wait.
- **The Gmail tab.** `EmailSidebar.tsx` already has the Local SMTP / Gmail
  toggle. The Gmail side keeps rendering its placeholder, untouched. Direct
  mailbox integration (Gmail, Outlook, self-hosted) is separate work and will
  land in the Email settings group this plan creates.
- **Mobile.** Web and desktop only. Desktop wraps web so it comes nearly free;
  mobile is a separate React Native stack and reading test mail is a desk
  activity. Revisit if it's actually missed.

## Capture

### Listener

One listener, one fixed port, on by default with the server.

- Default `0.0.0.0:1025`. Binding all interfaces is required: a loopback-only
  bind is unreachable from Docker on Linux and from a dev server on another
  box, which would undercut the remote-ready guarantee in AGENTS.md.
- Bind address, port, and on/off are configurable in Email settings.
- A taken port surfaces a visible error in Email settings and Diagnostics. It
  never silently shifts to another port — `.env` files across projects depend
  on the port staying put.
- STARTTLS is advertised with a self-signed cert; plaintext is still accepted.
  Some frameworks refuse to send without TLS on offer.

### Auth

Advertise PLAIN/LOGIN, accept any credentials, never validate the password.

The username is a **routing label, not a secret**. This means "point your app at
localhost:1025 with any user" just works, and the many frameworks that insist on
credentials get project routing for free. Documented plainly so nobody mistakes
it for a security boundary.

### Project routing

Attribution resolves in order, first match wins:

1. SMTP AUTH username matches a project's mail slug
2. SMTP AUTH password matches a project's capture password. This supports apps
   that use one fixed SMTP account while sending to arbitrary test recipients.
3. Recipient domain — `anything@<slug>.test`
4. Recipient plus-tag — `anything+<slug>@…`
5. No match → the central **Unassigned** inbox

Nothing is ever dropped. The resolved project and _which rule matched_ are both
stored and shown in the message's Metadata tab, so a misrouted email is
self-diagnosing.

`.test` is reserved by RFC 6761 and can never resolve publicly, so a stray real
send can't leak.

Rejected: a port per project. It matches the "central plus specific ones"
phrasing most literally, but costs a persisted port table, collision handling on
restart, and N ports to forward in tunnel mode.

### Mail slugs

`projectKey` today is `scopedRefKey()` = `<environmentId>:<projectId>`
(`packages/client-runtime/src/environment/scoped.ts:25`). It is opaque, and a
colon is illegal in a domain label — it cannot be the routing token.

Projects get a separate human-readable **mail slug**, auto-derived from the
directory basename (`~/code/My-App` → `my-app`), suffixed `-2` on collision,
stored, and editable in that project's settings alongside a copy button for the
full capture address. Every project has a working address from the moment it
exists, so nothing needs configuring before the first send.

### Environment scoping

Capture is bound to the **primary environment**, following the precedent set by
the issue tracker (`apps/web/src/state/issues.ts:4`). The listener runs on one
environment's host; a merged cross-environment inbox would misrepresent where
mail actually landed.

## Storage

A separate `mail.sqlite` under Pathway home, with raw `.eml` and attachments on disk
following the existing `attachmentStore` pattern.

Keeping disposable dev mail out of `state.sqlite` matters: that database is
event-sourced and gets snapshotted with `VACUUM INTO`, and capture data has no
business in checkpointing. "Clear inbox" becomes a truncate plus a file sweep.

Attachments are downloadable.

### Retention

Per-inbox message cap and an age cap, whichever hits first. Defaults: 500
messages per project inbox, 7 days. Configurable centrally, overridable per
project. Eviction deletes the `.eml` and attachments too, so disk actually goes
down. Manual "Clear inbox" per project.

Rejected: a single global size budget. It's honest about the real constraint,
but lets a busy project silently evict a quiet project's mail you were reading.

## Implementation

`smtp-server` + `mailparser`, wrapped as an Effect service.

Both are Nodemailer-family and battle-tested against a decade of real-world
broken MIME — nested multipart, quoted-printable, RFC 2047 encoded headers,
malformed boundaries. Hand-rolling MIME means rediscovering mailparser's bug
list, and the failure mode is "that one email renders blank". Complexity stays
at the adapter boundary, as AGENTS.md prescribes.

## Email view

### Navigation

`EmailSidebar.tsx` keeps its Local SMTP / Gmail toggle and gains an inbox list:

- **All mail**
- one row per project, with unread count and a mute toggle
- **Unassigned**
- **Analytics**

Main area is a two-pane mail client: message list left, message right.

Analytics respects the selected inbox scope, so you can look at one project's
volume or everything, without a second top-level route.

### Reading pane

Tabs above the pane:

| Tab                | Contents                                                                               |
| ------------------ | -------------------------------------------------------------------------------------- |
| **Preview**        | Sandboxed iframe, device-size buttons                                                  |
| **Metadata**       | Headers, routing explanation, attachments, links, tracking pixel count, sizes, timings |
| **Deliverability** | Offline structural checks                                                              |
| **Raw**            | `.eml` source and the SMTP transaction log                                             |

One thing at a time, and Preview gets full width — which matters because the
desktop device size needs the room.

### Preview rendering

`srcdoc` iframe, scripts disabled, strict CSP. Remote images and CSS are
**blocked by default**, with a per-message "Load remote content" button, exactly
like a real mail client.

This is not only a safety measure: blocking remote assets is what lets the
Metadata tab count and report tracking pixels instead of silently firing them at
someone's analytics.

### Device sizes

Three purpose-built presets — Desktop 1000px, Tablet 768px, Mobile 375px — plus
freeform drag with a live pixel readout.

Deliberately _not_ reusing `PREVIEW_VIEWPORT_PRESET_IDS`. That catalog is
device-hardware oriented (`iphone-se`, `surface-duo`, `nest-hub`), which is the
wrong axis for email: email layout convention is a 600px content table, and
offering "Nest Hub Max" as an email preview size is noise.

### Unread

Per-message read/unread. Opening marks read; explicit "mark unread" and "mark
all read" per inbox. Unread badges on the Email nav item and each project row.
Satisfies the reverse-state rule — every way in has a way out.

## 2FA codes

### Detection

Built-in heuristic scanning subject and body for a 4–8 character code near
keywords (code, verification, OTP, one-time, passcode, confirm), plus an
optional per-project regex override in project settings.

Zero setup is the point: an agent hitting a login flow blind has no chance to
configure anything first. The override exists for the app you test daily and for
fixing a false positive.

### Notification

An in-app toast for **every captured email**, showing the detected code in large
mono with a copy button when one is present. Fires from any route.

I argued for code-detected-only on noise grounds — a dev server sends signup,
reset, and receipt mail constantly, and noise gets muted, which kills the
feature. Overruled; building it as chosen, with the escape hatch below.

Escape hatch: per-project mute toggles on each sidebar inbox row, plus a master
switch in Email settings. Mute a chatty project while keeping the one under test
loud.

Not in this build: OS notifications, mobile push, auto-copy to clipboard.

## Deliverability checks

Offline and structural only. No network calls, fully deterministic, testable.

- SPF/DKIM/DMARC header presence and syntax validity
- DKIM signature structural parse (not cryptographic verification)
- Missing `List-Unsubscribe`
- Missing `text/plain` alternative
- Subject length, image-to-text ratio, tracking pixel count
- HTML client-compat warnings from a static caniemail-style rule table

Rejected: real DNS lookups and DKIM verification. They genuinely answer "would
this authenticate", but cost network calls, make tests non-deterministic, and do
nothing for the `localhost` and `example.com` senders that are most of local
dev. Also rejected: a SpamAssassin-style scoring engine — a large domain surface
scoring against rules no real receiver uses.

## Agent access

MCP tools alongside the existing `preview_*` toolkit in `apps/server/src/mcp/`,
on the v2 server:

- **`email_wait_for`** — returns when a message matching
  sender/subject/recipient arrives. See below for how it delivers.
- **`email_latest_code`** — most recent detected code, optionally project-scoped,
  with sender and age so an agent can tell stale from fresh.
- **`email_list`** — paginated, filterable list.
- **`email_get`** — full message by id: text, HTML, headers, attachments, links.

WS RPC ships regardless, since web and desktop need it.

### Tool scoping

Tools default to the calling thread's project, with an explicit `project`
parameter to widen and an `all` option.

The MCP bearer credential is already bound to a `threadId` and
`providerInstanceId` (`McpSessionRegistry.ts:14-27`), so the scoping information
is sitting there for free. An agent testing project A doesn't wade through
project B's mail, and can't pick up a 2FA code meant for a different app's test
run. Widening stays possible so a misrouted email is still debuggable from
inside an agent.

### Push, not polling

`email_wait_for` degrades by declared capability and upgrades automatically:

- **Client declared `io.modelcontextprotocol/tasks`** — return a
  `CreateTaskResult` and push `notifications/tasks` carrying the full task state
  the instant mail arrives. Zero polling.
- **Client didn't** — hold the tool call open as a bounded long-poll (default
  120s, configurable) and return the message when it lands.

The fallback is not optional pessimism: core v2 support and tasks-extension
support are separately negotiated, and the official extension matrix doesn't
track tasks at all. This shape works with every agent on day one and gets
strictly better as clients ship tasks support, with no changes here.

Project inboxes are also exposed as **MCP resources** —
`email://project/<slug>/inbox` — so an agent can open `subscriptions/listen`
with that URI in `resourceSubscriptions` and receive
`notifications/resources/updated` when mail lands, without holding a wait open.

### Waking a waiting agent

A wait is a pending tool call belonging to a live turn. When mail matches, the
server resolves that call — by pushing `notifications/tasks` or by completing
the held long-poll — and the agent's own turn continues with the email as the
tool result.

No message injection, no synthetic turn, nothing provider-specific. It is just a
tool call that took a while to return. Rejected: injecting a user message (it
fabricates input the user never wrote, which reads as confusing history) and
emitting a typed orchestration event (five adapter implementations for something
the tool-call return already handles).

### Wait durability

Wait registrations are persisted in `mail.sqlite`, not held only in memory.

- A tasks-capable client resumes with `tasks/get` on the same `taskId` after any
  disconnect — the spec requires tasks be durably created before the response is
  sent, precisely for this.
- A long-poll client's call closes on restart, but the wait survives, so
  re-calling `email_wait_for` with the same criteria immediately returns
  anything that arrived meanwhile.

Rejected: in-memory only. A server restart mid-login-flow would silently lose
the email the agent was waiting for, and that failure is invisible and
maddening to debug.

**Known gap:** no public REST API, so external Playwright/CI suites can't poll
the inbox without going through MCP. Accepted for now; revisit if it bites.

## Mail-triggered agent runs

Two paths by which mail causes agent work.

**Agent-registered waits.** Covered above — the agent explicitly opted in, and
the effect is scoped to its own turn.

**Project trigger rules.** A rule matches on sender, subject, or recipient and
starts a **new thread** in the rule's project from a prompt template, with
variables for sender, subject, body, detected code, and message id. The message
id lets the triggered agent pull full detail via `email_get`.

A fresh thread per firing keeps runs isolated and inspectable, and means a
firing can't corrupt a conversation in progress. Rejected: appending to a
designated long-lived thread, which grows unbounded and lets one bad firing
pollute every later one.

### Runaway protection

This is the part that needs care. The listener binds `0.0.0.0` and accepts any
credentials, so a trigger rule is a path from "anyone who can reach port 1025"
to "agent work runs". Three guards:

- **Off by default.** No rule exists until you create one.
- **Rate limit.** Each rule carries a max-triggers-per-hour cap.
- **Loop detection.** A rule whose own agent run sends mail that matches the
  same rule trips detection and auto-disables, with a visible notice.

Every firing is logged with the message that caused it, so a misfiring rule is
diagnosable rather than mysterious.

Rejected: rate limiting alone — a self-triggering loop would just run at exactly
the cap forever, quietly burning tokens.

If trigger rules ever grow to auto-start on arbitrary unmatched mail, the
`0.0.0.0` bind and accept-any auth need rethinking first. Full rules-engine
autonomy was explicitly not chosen for this reason.

## Settings

`SETTINGS_NAV_GROUPS` gains an **Email** group, and **Projects** joins
**Workspace**.

Email gets its own group rather than living under System because the future
Gmail/Outlook integration is clearly not a System concern and would have to move
again. This way it lands in an existing home.

### Restoring Settings → Projects

Project settings was not lost — commit `f21d5e444` ("Move project settings to
contextual project routes", #5923) deliberately moved it, deleting
`settings.projects.tsx` and `settings.projects_.$projectKey.tsx` and re-homing
the 1,217-line `ProjectSettingsPanel` at `/projects/$projectKey`.

Restoring it is a **deliberate divergence from upstream**, not a bug fix.

- Add back `/settings/projects` (index listing all projects) and
  `/settings/projects/$projectKey` subpages, both rendering the existing
  `ProjectSettingsPanel`. No panel rewrite — this is routing plus
  `settingsSearch` entries.
- Keep `/projects/$projectKey` working as an alias, so the contextual entry
  point and the command palette entries #5923 added don't break.

Per-project email config (mail slug, retention overrides, 2FA regex override,
toast mute) lives on the project subpage.

## Staging

A prerequisite, then three stages, each shippable and reviewable on its own.

**Stage 0 — [MCP v2 migration](./mcp-v2-migration.md).**
Its own PR, landing before any email work. New transport on the official SDK,
`server/discover`, per-request capabilities, `subscriptions/listen`, tasks
extension, existing toolkits re-declared and verified per provider. Email tools
then land on a v2 server that already works, and a v2 regression can't entangle
itself with email shipping.

**Stage 1 — capture works end to end.**
SMTP listener, MIME parsing, `mail.sqlite`, the routing chain and mail slugs,
retention, WS contract, basic list and reading pane, the four MCP tools with
tasks/long-poll degradation and persisted waits, inbox resources, central Email
settings page.

**Stage 2 — the polish.**
Device-size preview with the sandboxed iframe and remote-content blocking,
Metadata and Raw tabs, 2FA detection, toasts and mutes, unread state and badges.

**Stage 3 — the reporting and automation.**
Analytics view, deliverability checks, project trigger rules with rate limiting
and loop detection, and the Settings → Projects restoration.

## Verification

Effect tests against a real in-process listener on an ephemeral port. Send real
messages with nodemailer covering every routing path — AUTH username, domain,
plus-tag, unmatched — plus malformed-MIME and attachment fixtures. Assert on
persisted rows and emitted receipts, never on sleeps or polling, per the
event-sourcing rule in AGENTS.md. Then one manual send from a scratch script to
eyeball the UI.

Push and trigger paths need their own coverage:

- `email_wait_for` returns a task to a tasks-capable client and long-polls for
  one that isn't — both against the same fixture
- `notifications/tasks` fires on arrival, and carries full task state so no
  `tasks/get` round-trip is needed
- A wait survives a server restart: tasks resume by `taskId`, long-poll waits
  return the message that arrived while disconnected
- Tool scoping — a thread in project A sees A's inbox by default and B's only
  when it asks
- A trigger rule fires once per matching message, respects its hourly cap, and
  auto-disables when its own run produces a matching message

A browser pass with `test-t3-app` needs explicit sign-off each time, per the
same document.

## Docs

- `docs/user/` — the feature, in shipped-product voice
- `docs/internals/` — capture architecture and the routing chain
- `docs/internals/glossary.md` — new vocabulary (mail slug, capture address,
  Unassigned inbox)
