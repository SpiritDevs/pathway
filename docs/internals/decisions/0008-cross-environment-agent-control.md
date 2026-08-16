# 0008 — Cross-environment agent control

Status: Accepted
Date: 2026-08-14

## Context

[remote.md](../remote.md) defines one runtime boundary: a client connects to one Pathway server,
and that server owns orchestration, providers, terminals, Git, and the filesystem. Pathway Connect
can carry a client-to-environment connection, but one environment cannot discover or control
another environment.

Company projects and thread links now identify the environment that owns their local binding or
runtime state ([0007](0007-convex-company-local-first-sync.md)). Starting or steering work from a
different machine needs both an offline-tolerant path and a low-latency live path without making
provider processes, files, Git state, or thread transcripts cloud-owned.

## Decision

Cross-environment agent control ships in three ordered, independently gated layers. This decision
amends the one-runtime-boundary invariant in [remote.md](../remote.md): one environment may act as a
client of another environment, but execution remains wholly owned by the target environment.

### 1. Company environment registry and discovery

Convex stores company environment registrations, descriptors, relay link state, managed-endpoint
availability, project bindings, last-seen metadata, and cloud-safe Agent Thread shells. A thread
shell contains routing and presentation metadata (owning environment/project, title, provider,
model, status, run state, timestamps, and counts), but removes message text. A member needs
`environments.read` to list and inspect registrations and `environments.manage` to administer them.

Clients merge company registry entries into their existing device-local connection catalog and use
the replicated Agent Thread shells as a discovery fallback. Selecting a thread or starting work in
a bound project connects to the binding's environment; once connected, that environment's live
shell and thread-detail streams replace the cloud fallback.
Connecting still uses the existing relay brokering and Cloudflare tunnel data plane described in
[remote.md](../remote.md); the relay Worker remains a credential and endpoint broker rather than an
application-data proxy.

The client presents a short-lived Convex-issued connect grant naming the environment, user,
permission, and expiry. The relay validates the grant against the Convex issuer, and the target
environment independently checks the actor's company permissions against its synchronized replica
before issuing a credential or accepting a WebSocket ticket. Revoking membership, the permission,
or the registration blocks new connects even when a previously issued grant has not reached its
expiry.

### 2. Convex command-record dispatch

Company-scoped `environmentCommands` carry start-thread, send-message, interrupt, and status-query
requests. Each record names the target environment, project binding, acting identity, arguments,
TTL, claim, status, and result metadata.

Issuing a command requires the remote-agent dispatch permission plus the matching orchestration
permission. A target environment transactionally claims only its own commands using renewable,
idempotent claims. Pending commands for offline environments remain visible and cancellable until
claimed or expired; expiry is recorded explicitly. Results and thread status transitions return as
command status records through the ordinary sync feed.

Command arguments obey the sync operation size limits. Thread transcripts, streamed tokens, file
contents, and other bulk runtime data never enter command records.

### 3. Direct environment-to-environment control

The relay adds a server client ID authorized for the new `environment:connect` scope. The initiating
environment authenticates with its existing Ed25519 environment key and DPoP proof.

`apps/server` gains a client-runtime connection handle by adopting or extracting the transport and
RPC session layers from `packages/client-runtime`. It drives a peer through the same WebSocket RPC
surface used by remote human clients; there is no federation protocol beside the existing one.

Every call carries both the initiating environment's service identity and an on-behalf-of actor,
which may be a member or agent. The target checks that actor's company permissions from its local
synchronized replica. The initiating environment's service identity alone grants nothing.

The orchestrator exposes remote targeting through an explicit target-environment parameter. Local
execution remains the default, and same-project scoping is evaluated within the target environment.
Direct control carries live thread streaming and steering when a peer path exists. Convex command
dispatch remains the fallback when it does not.

Thread content never enters the Convex change feed. The direct WebSocket over the existing Connect
tunnel carries the authoritative transcript, streaming output, diffs, approvals, and file context;
Convex carries the redacted thread index, discovery, authorization, durable dispatch, status, and
bounded results only. The relay Worker continues to broker credentials and endpoints rather than
storing application data.

## Consequences

- The target remains the only owner of its provider processes, local paths, Git state, terminals,
  threads, and checkpoints. Cross-environment control does not make runtime state portable.
- `apps/server` now has both server and client responsibilities. Reusing the client-runtime session
  layer keeps authentication, compatibility, reconnect, and RPC behavior aligned with other
  clients.
- Authorization is checked at dispatch and again at the target. A stale or compromised initiating
  environment cannot borrow its registration to act without a currently authorized on-behalf-of
  actor.
- Convex dispatch may execute later than requested. TTL, cancellation, claims, and explicit
  pending/claimed/expired states make that delay visible and recoverable.
- Direct and deferred paths need one idempotency identity so fallback cannot run a command twice.
- Existing client-to-environment Connect behavior remains unchanged.

## Alternatives rejected

- **Send all control through Convex.** Durable and offline-tolerant, but unsuitable for token
  streaming and low-latency steering, and it would put thread content into the change feed.
- **Require a direct path.** Simple for online peers, but commands disappear as a capability when
  machines cannot be online or mutually reachable at the same time.
- **Route application traffic through the relay Worker.** Changes the relay's trust, payload, and
  scaling boundary when the existing tunnel data plane already transports WebSockets.
- **Trust the initiating environment identity as the actor.** An environment registration is a
  service credential, not proof that the member or agent may perform the requested company action.
