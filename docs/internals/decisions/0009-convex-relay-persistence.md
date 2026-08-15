# 0009 — Relay operational state lives in Convex

Status: Accepted
Date: 2026-08-14

## Context

The relay originally persisted links, environment credentials, managed endpoint allocations, DPoP
replay proofs, mobile registrations, agent activity, and delivery attempts in PlanetScale Postgres
through Cloudflare Hyperdrive. Company discovery and issue synchronization now require Convex, and
no production relay database has been provisioned yet. Keeping Postgres would introduce another
account, deployment lifecycle, migration system, and baseline database cost before any data exists.

The relay remains a Cloudflare Worker because it owns HTTP token exchange, managed tunnels and DNS,
queues, APNs delivery, and the direct Connect data plane. This decision concerns durable operational
state only.

## Decision

Store relay operational state in the existing Pathway Convex project.

- The Worker calls typed Convex queries and mutations through `ConvexHttpClient`.
- An Alchemy-managed P-256 key signs short-lived `aud=pathway-convex`,
  `sub=pathway-relay`, `tokenKind=relay-control-plane` JWTs. Convex authorizes this identity
  separately from Clerk members and registered environments.
- The Worker publishes the signing key at `/.well-known/jwks.json`; no Convex deploy key is stored
  in Worker configuration.
- Transaction-sensitive SQL paths become single Convex mutations. This includes link and credential
  replacement or revocation, token ownership, delivery leases, endpoint claims, and DPoP replay
  consumption.
- PlanetScale, Drizzle, and Hyperdrive leave the relay deployment.

A fresh deployment creates the Convex deployment first, deploys the relay so its persistence-free
JWKS route is public, then configures the relay custom-JWT provider and installs the Convex
functions. Convex statically requires both relay provider variables before codegen or deployment.

## Consequences

- Company, issue-sync, discovery, and relay operational data share one managed backend and one
  deployment model.
- Relay persistence calls now depend on Convex availability and network latency. JWKS remains
  available directly from the Worker so authentication bootstrap and key discovery do not depend on
  a successful database call.
- Convex mutations provide the atomic and serializable boundary previously supplied by SQL
  transactions.
- Personal relay stages can target personal Convex deployments without provisioning database
  branches.

## Alternatives rejected

- **Keep PlanetScale and Hyperdrive.** Preserves the existing repository implementation, but adds a
  second durable backend and non-trivial standing infrastructure for state Convex can model.
- **Cloudflare D1.** Keeps state near the Worker, but still creates a second schema and migration
  lifecycle while company environment discovery is already Convex-backed.
- **Convex deploy key in the Worker.** Simple to call, but grants administrative database access.
  A narrow, short-lived service identity is safer and supports ordinary function authorization.
