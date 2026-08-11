# 0005 — Company modelled as a Clerk organization

Status: Accepted — implementation deferred; ships as its own change after the auth surfaces land
Date: 2026-08-11

## Context

The company branch of onboarding was initially a set of self-asserted strings: company name, size,
role. Those are harmless in `unsafeMetadata` ([0003](0003-profile-in-clerk-user.md)).

Adding "auto-assign other people from the same email domain to this company" changes their nature
twice over.

First, membership becomes authorization-bearing: it decides who is placed into whose account.
`unsafeMetadata` is client-writable by the signed-in user — the name is a warning, not a
description of intent — so anyone could write themselves into any company.

Second, auto-join presupposes a **company that exists independently of the person who typed its
name**: something to be assigned _to_, that outlives its creator and has some notion of who
administers it. That is a second aggregate with membership, which is an organization system.

Deciding "a real company domain, not Gmail" by email suffix is a heuristic with no clean answer.
The list of free and disposable providers is large and never complete, and the check cannot run
on the client, which is the party with a motive to lie.

## Decision

A company is a Clerk organization. Clerk's verified domains with automatic enrollment provide
organization identity, membership, roles, invitations, and server-enforced domain verification —
the described feature, already built, already present in all three SDKs.

**Membership grants nothing in v1.** No shared billing, no shared visibility, no seats, no access
to another member's projects or threads. It is a label with a real backing entity.

**Joining is opt-in by the joiner.** When a registering user's verified email domain matches an
existing organization, onboarding offers it — "It looks like you work at Acme. Join your team?" —
with a visible decline. No silent membership change.

Company name, size, and role: the name is the organization's, the size and role stay on the user's
`unsafeMetadata` as self-asserted answers.

## Consequences

- **Pending sessions become real.** Organizations introduce session tasks such as organization
  selection, which put a Clerk session into `pending`. There are nine `treatPendingAsSignedOut:
false` call sites across web and mobile — `apps/web/src/routes/__root.tsx:111`,
  `apps/web/src/routes/login.tsx:20`, `apps/web/src/cloud/managedAuth.tsx:41`,
  `apps/web/src/components/cloud/ConnectOnboardingDialog.tsx:52`, and five under
  `apps/mobile/src/features`. Today they paper over a state that rarely occurs. Once organizations
  are enabled, each is load-bearing and needs a deliberate answer. This is the highest
  implementation risk in the whole change.
- Individuals have no organization. Nothing may block on an active organization being set, or the
  individual branch deadlocks at the gate.
- Because membership grants nothing, a wrong auto-join is cosmetic rather than a breach. That is
  what makes shipping it with an email-domain heuristic acceptable **now**, and it stops being
  acceptable the moment membership grants anything. Any future grant — billing, shared threads,
  teammate visibility — requires revisiting this record, and probably DNS-proved domain ownership
  rather than suffix matching.
- Confirm verified domains and automatic enrollment are available on the Clerk plan this fork
  uses before building against them; organization features are tiered.
- Opt-in joining means the offer must be declinable and re-offerable. A contractor with a client
  domain, or someone who declines by accident, needs a path in later from company settings.

## Alternatives rejected

- **Relay tables (`companies`, `memberships`).** Full control and the only option where company
  answers are directly queryable by us, which was the original motivation for owning the data. But
  it rebuilds organization CRUD, membership, domain verification, and invitations against
  `@clerk/backend`, plus relay endpoints and a Clerk webhook.
- **Company as a plain label, auto-join deferred.** The smallest model that works, and the right
  answer if auto-join were not wanted in v1.
- **Silent auto-assign.** What was originally described. Places a user into a shared account
  without telling them.
- **Invite links only.** No classification problem at all, but no growth loop.
