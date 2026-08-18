# 0010 — Company integrations and durable automation

Status: Accepted
Date: 2026-08-18

## Context

Slack intake and issue automation originally belonged to one Pathway environment. That was correct
for a personal workspace, but an organisation can connect several environments to the same company.
If two of them poll the same Slack channel, local cursors and deduplication cannot prevent duplicate
issues or duplicate Slack replies. The same problem applies to automation intent: a process-local
observer can forget work when its machine goes offline and another environment cannot safely know
whether the work already ran.

Company configuration also cannot be trustworthy when credentials and routing rules live in one
machine's settings file. Administrators need one shared view, explicit executor priority, and an
inspectable answer when work cannot run.

## Decision

Convex owns organisation Slack integrations and issue-automation intent. Environments execute work,
but they cannot create a second authority. Personal workspaces keep the existing SQLite settings,
poller, cursors, and automation coordinator behind the same Integrations UI.

### One lease per Slack workspace

Each Slack integration represents one canonical Slack workspace ID in one company. Its configured
controller pool contains one preferred environment and no more than ten ordered backups. Eligible
environments heartbeat every 30 seconds. One environment holds a 90-second, monotonically generated
lease; every cursor, intake, health, and outbound-delivery mutation must present that generation.

Selection follows the configured order and never admits an arbitrary company environment. A backup
takes over only after the current lease expires. A returning preferred environment must publish two
healthy heartbeats; the backup then stops renewing and the preferred environment takes the next
lease boundary. Pool edits, environment revocation, disconnect, and credential replacement fence
the current holder immediately.

Lease heartbeats are operational state, so they do not enter the company replica feed.

### Central Slack ledger

Convex owns channel watches, message and reaction cursors, processed roots and replies, ignored
messages, outbound delivery claims, and bounded health. The source identity is:

`company + integration/workspace + channel ID + Slack timestamp`

Slack issue creation is one Convex transaction: validate the live lease and watch, check the source
identity, create the issue and audit/change-feed rows, record the canonical source, and enqueue any
automation jobs. Only the transaction that reports `created: true` may confirm the issue to Slack.

Outbound messages carry an opaque deterministic delivery ID in Slack message metadata. After a
timeout or executor loss, the next controller claims the same delivery, reads the thread including
metadata, and records an existing post before deciding to send. Generation fencing prevents a stale
controller from completing the claim.

### Credentials

Organisation bot tokens are validated with Slack `auth.test` and encrypted before storage using
AES-256-GCM, a fresh 96-bit IV, and associated data containing company, integration, and workspace
IDs. Ciphertext stores the key ID, IV, authentication tag, and ciphertext only. A live lease holder
may decrypt through an authenticated Convex action; plaintext remains in process memory for that
lease and is never written to the environment filesystem.

The versioned operator keyring is configured by
`PATHWAY_INTEGRATION_CREDENTIAL_ACTIVE_KEY_ID` and
`PATHWAY_INTEGRATION_CREDENTIAL_KEYS`. Old keys remain until an operator re-encrypts every
credential that references them.

### Durable automation jobs

Convex creates automation jobs in the transaction that accepts the authoritative issue change.
Deterministic trigger keys make scheduling idempotent. A job retains its settings revision, immutable
rule/model snapshot, execution target, required provider instance and model, attempts, claim state,
and a structured block or failure reason.

Automation does not use the Slack controller pool. Each job already has a project or thread target,
so an eligible target environment claims it for 90 seconds and renews every 30 seconds. Stale claim
generations cannot commit results. Claims pin running work; unclaimed project work may be retargeted
when the preferred binding changes.

Environments publish bounded, non-secret provider capability snapshots. Missing environments,
bindings, provider instances, disabled providers, and unavailable models block visibly. No model
fallback is inferred. Capability changes and a periodic recovery mutation re-evaluate blocked jobs.
Transient failures retry after about one, five, and fifteen minutes, then become terminal. Only a
terminal failure creates a failure comment. Completed jobs are retained for 90 days; issue comments
and audit history retain user-visible results.

### Activation and mixed versions

Slack integration and company automation activate independently. Organisation-local configuration
is not imported. An integration remains a draft until its preferred and backup environments report
compatible capabilities, the preferred environment is healthy, and an administrator confirms old
watchers were upgraded or disconnected (or the old token was rotated).

After activation, upgraded environments leave matching organisation-local Slack watches inert.
After automation activation, the local automation coordinator is inert. Disconnecting or pausing
does not fall back automatically, because fallback would reopen duplicate ownership.

Older Slack-linked issues decode without integration/workspace metadata and remain readable. They
are deliberately not guessed into a workspace and cannot resume two-way Slack synchronisation.

## Consequences

- Every administrator sees the same credentials-present state, watches, controller order, health,
  and jobs.
- Slack polling requires Convex connectivity. If Convex is unavailable, polling pauses and later
  resumes from the shared cursor.
- Duplicate provider computation remains possible after an ambiguous crash, but only one fenced
  result may mutate company state.
- Removing an integration deletes its operational ledger but preserves issues and their source
  display as read-only history.
- The web and Electron clients share management UI. Mobile management remains out of scope.

## Alternatives rejected

- **First machine wins.** It is invisible, unstable after restart, and unsafe during mixed-version
  rollout.
- **One coordinator for the whole company.** It couples unrelated Slack workspaces and creates
  unnecessary failover and load-balancing behavior.
- **Round-robin polling.** Shared cursors do not make overlapping external reads or sends safe, and
  administrators cannot reason about which machine is responsible.
- **Environment-local deduplication with eventual merge.** It detects duplicates after users have
  already seen two issues and two Slack confirmations.
- **A controller pool for automation.** Jobs already have authoritative project/thread targets;
  adding a second election mechanism creates conflicting ownership.
- **Plaintext Convex secrets or local token distribution.** Both broaden the credential boundary and
  make revocation/fencing harder to enforce.
- **Automatic fallback to legacy local polling.** It restores the exact split-brain condition this
  decision removes.
