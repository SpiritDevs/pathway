# 0001 — Accounts are required to open the app

Status: Accepted
Date: 2026-08-11

## Context

Upstream Pathway treats identity as a Pathway Connect concern. Clerk exists so the relay can verify a
bearer token ([t3-connect.md](../t3-connect.md)); the app itself runs with no account, and cloud UI
is omitted entirely when `PATHWAY_CLERK_PUBLISHABLE_KEY` is absent. `AGENTS.md` states the project
is "open at the core" and that a large number of users run forks.

This repository is a product fork, not upstream. The product requires a known user for every
session: registration, profile, and company are the entry point, not an optional cloud add-on.

## Decision

Signing in is required to reach any application surface.

`resolveClerkAuthGateState` is the single gate. An unauthenticated visitor is redirected to
`/login` regardless of relay configuration. `hasClerkPublicConfig()` — split out of
`hasCloudPublicConfig()` so that Clerk identity no longer implies a configured relay — is the
predicate that turns the gate on.

A build with no Clerk publishable key does **not** fall through to an open app. It is a
misconfiguration and fails closed.

## Consequences

- This reverses the open-at-the-core promise upstream Pathway's `AGENTS.md` made ("Pathway is
  truly open… A large number of our users run forks"); that section has since been removed from
  this fork's copy, and this record preserves the before-state. A fork of this fork must
  provision its own Clerk application to run the software at all. Anyone reading
  `hasClerkPublicConfig()` and expecting upstream's "no key, no cloud UI, app still works"
  semantics will be wrong; that is why this record exists.
- The app requires network reachability to Clerk on cold start once the cached session lapses.
  A local coding agent that cannot open offline is a real regression against upstream and is
  accepted here deliberately.
- Password reset is not optional. Under an optional gate a forgotten password costs you cloud
  features; under this gate it costs you the application. See
  [0002](0002-first-party-auth-forms.md).
- `AGENTS.md` guidance about the 100k-user contract and upstream maintainer sign-off is inherited
  context for this fork, not a binding constraint.

## Alternatives rejected

- **Gate hosted web only.** Two products to maintain, and it does not serve a fork whose premise
  is a known user.
- **No key means no gate.** Makes the gate removable by deleting one line of `.env`, which is not
  a gate.
