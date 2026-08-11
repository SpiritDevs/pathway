# 0003 — User profile lives on the Clerk user

Status: Accepted
Date: 2026-08-11

## Context

Nothing in Pathway is user-scoped. `apps/web/src/hooks/useSettings.ts` documents the only two
storage tiers that exist: server-authoritative settings in `settings.json`, owned by one T3 server
on one machine, and client-only settings in localStorage. Both are per-machine by construction,
because each computer runs its own server. The relay's schema
(`infra/relay/src/persistence/schema.ts`) has no users table — a Clerk `sub` appears only as a
partition key on devices, links, and allocations.

A user profile is therefore the first user-scoped aggregate in the system, and neither existing
tier can hold it.

The desired behaviour is cross-device: change your avatar on the laptop, see it on the desktop.
A general-purpose sync engine is wanted eventually but is explicitly deferred.

## Decision

Store the profile on the Clerk user.

- `firstName`, `lastName`, `imageUrl` — native Clerk fields. Avatars upload through
  `user.setProfileImage`, which hosts the image; we store no blob and serve no file.
- Everything self-asserted and non-authorizing — account kind, how they heard about us, which
  providers they use, onboarding completion — goes in `unsafeMetadata`.

Reading is `useUser()`, which is the same API on `@clerk/react`, `@clerk/electron`, and
`@clerk/expo`.

## Consequences

- Cross-device profile sync is obtained without building a sync engine. Clerk is already the one
  store every client authenticates against, so the outcome originally motivating the sync engine
  arrives for free at the profile layer.
- No avatar storage to design: no base64 in a 5 MB localStorage quota, no file on disk to serve,
  no R2 bucket.
- Onboarding resumes on any device, because completion state is on the user rather than the
  machine. A user who registers on mobile and reopens on web continues where they stopped.
- `unsafeMetadata` is **client-writable by the signed-in user**. Nothing that grants access may
  live there. Company membership therefore does not — see
  [0005](0005-company-via-clerk-organizations.md).
- Migration to the future sync engine is a backfill script reading the Clerk API, not a
  data-loss event. The metadata shape should be versioned from day one to make that read cheap.
- Profile writes require network. Onboarding cannot complete offline.

## Alternatives rejected

- **localStorage / `ClientSettings`.** Truly local, and therefore different on every device and
  lost on cache clear, with base64 avatars against a 5 MB quota.
- **Local SQLite (`state.sqlite`).** Survives cache clears, but is per-environment: connect to a
  different machine and the profile is gone. Wrong scope for a user-scoped aggregate.
- **Relay Postgres now.** The eventual home for business data, and the only option that makes
  company answers queryable by us — but new tables, endpoints, and a cache story for three
  clients, ahead of knowing what we want to ask.
