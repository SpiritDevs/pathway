# 0007 — Convex company authority and local-first issue sync

Status: Accepted
Date: 2026-08-14

## Context

[0005](0005-company-via-clerk-organizations.md) deferred company ownership to Clerk
Organizations. That model supplies membership and invitations, but it cannot express the company,
team, role, workflow, environment, project, and issue authorization model now required without
splitting authority across identity and application stores.

[0006](0006-issue-tracker.md) made the issue tracker authoritative in one environment's SQLite
database. That was the smallest available persistence model at the time, but it makes a different
tracker appear on every machine and cannot support company-wide planning, offline edits from several
clients, or coordinated integrations.

Pathway still needs to open and edit issues without a network connection. Moving authority to a
hosted backend therefore cannot turn the issue UI into an online-only view over remote queries.

## Decision

Convex is the authoritative backend for companies, memberships, teams, roles, invitations, cloud
projects, issues, planning records, audit history, integrations, environment registrations, and
synchronized execution state. Clerk remains mandatory user identity only. This supersedes the
Clerk-Organizations decision in [0005](0005-company-via-clerk-organizations.md) and amends the
environment-scoped issue authority accepted in [0006](0006-issue-tracker.md).

The full protocol and replica behavior are documented in [cloud-sync.md](../cloud-sync.md). The
company and authorization model is documented in
[companies-and-permissions.md](../companies-and-permissions.md).

### Tenancy and ownership

- Every synchronized record belongs to one company. A user may belong to any number of companies
  and teams.
- First sign-in creates an ordinary one-member company. Personal use is not a separate tenancy
  model.
- Ownership is separate from configurable roles. A company may have multiple owners, and owners
  pass every authorization check.
- Removing, locking, or allowing the departure of the final owner is rejected transactionally.
  Any owner may add or remove another owner and schedule or restore company deletion.

### Authorization

Role assignments are allow-only. Effective permissions are the OR-union of every applicable role
assignment; there are no deny assignments whose precedence must be resolved.

A company-scoped assignment applies across the company. A team-scoped assignment applies only to
records visible through that team. Access through any team attached to an issue exposes the complete
issue, including comments, attachments, relations, and history. A role in one team cannot grant
access through another. Company-administration permissions do not become company-wide merely because
they are present in a team-scoped assignment.

Authorization-bearing changes increment a company authorization epoch. A client that observes a new
epoch purges records it can no longer see and reseeds the affected replica rather than trusting its
previously filtered cache.

### Replication and conflicts

Web, Electron, and Pathway servers retain durable local replicas. Issue-domain writes enter a durable
outbox and render as an optimistic overlay over confirmed state. Company, membership, team, role,
invitation, integration, host, and project-binding administration remains online-only.

Convex serializable commit order is the conflict clock. Different fields merge independently; when
two accepted operations write the same field, the later Convex commit wins. Client clocks never
choose a winner. Stale-base overwrites retain before and after values in audit history. Deletes
tombstone an entity, and later updates are rejected until an explicit restore.

Sync changes and operation receipts are retained for 90 days. A cursor older than the retained feed
causes the client to discard confirmed state and perform a full paginated bootstrap. Issue audit
history remains until company deletion.

Offline access defaults to 30 days and is configurable per company from zero through 90 days. Zero
requires an online authorization check before company data opens. A new device cannot bootstrap
offline. Every successful authorization refreshes the local access grant.

### Services and coordination

One environment holds the company integration coordinator lease at a time. The lease has a 90-second
TTL and renews every 30 seconds. Side-effect claims include the lease generation; losing the lease
prevents new side effects, and transactional, idempotent claims recover after expiry.

Pathway servers do not authenticate to Convex as human users. The relay exchanges an environment's
existing DPoP-bound credential and proof for a short-lived service JWT with
`aud=pathway-convex`, the environment ID, public-key thumbprint, and token ID. Convex validates the
relay issuer, then resolves company registrations, team scopes, and service-role permissions from
its own authoritative records. Revoking an environment registration prevents future exchanges.

## Consequences

- SQLite issue tables become company-scoped replicas rather than independent authorities. Existing
  issue data requires a resumable, checksum-verified import before cloud cutover.
- Clients can render and edit issue data while offline, but administration and first bootstrap need
  Convex and Clerk connectivity.
- Permission-filtered feeds and authorization epochs are part of the security boundary. Advancing a
  cursor through an empty filtered page and purging inaccessible cached data are correctness
  requirements, not optimizations.
- Server commit order is deterministic but does not preserve a user's notion of wall-clock order.
  The audit trail is the recovery surface for a valid but unwanted overwrite.
- Ninety-day retention bounds the change feed and operation receipt tables at the cost of occasional
  full bootstrap for dormant clients.
- Clerk organization membership, verified domains, and organization roles are not consulted for
  application authorization. Clerk profile data from [0003](0003-profile-in-clerk-user.md) remains
  identity and onboarding data only.

## Alternatives rejected

- **Keep Clerk Organizations authoritative and mirror into Convex.** Creates two authorization
  authorities and ambiguous ordering for membership, roles, teams, and invitations.
- **Keep each environment's tracker authoritative and synchronize peers.** Requires peer discovery,
  conflict authority, and an always-available coordinator while still failing when every environment
  is offline.
- **Make issues online-only.** Removes the local-first behavior required for coding work on laptops
  and unreliable networks.
- **Use client timestamps for last-write-wins.** Clock skew makes outcomes non-deterministic and lets
  clients influence authority by setting their clocks.
