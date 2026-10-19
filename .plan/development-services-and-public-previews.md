# Development Services and Public Previews

Status: Proposed  
Last updated: 2026-08-21  
Owners: Pathway maintainers

## 1. Summary

Pathway should let a project define long-running development services, start and stop them from the app or MCP, associate a running instance with a thread, and expose the resulting HTTP service through a stable Pathway-managed URL.

The experience should feel like a native extension of the existing Development Environments service area:

1. A user or agent starts a service for the current project.
2. Pathway runs the command and detects the listening port.
3. The service is immediately available to authenticated Pathway clients through the environment connection.
4. The user can optionally publish it with a secret public URL.
5. Pathway Connect and a Cloudflare gateway handle routing and TLS. The user does not configure certificates, DNS, routers, or firewall rules.
6. If a thread-owned service is archived, Pathway stops its process and removes its public route. The saved service definition remains available for later reattachment.

This is preview infrastructure, not general-purpose production hosting. It is intended for development servers, prototypes, demos, and agent-driven verification.

## 2. Goals and success criteria

### Goals

- Give every project a durable set of named service definitions.
- Let users and agents start, inspect, restart, stop, and archive service runs.
- Let a run be project-scoped or attached to a specific thread.
- Make a running HTTP service reachable from web and desktop Pathway clients, including remote clients.
- Let a user create a stable, secret public preview URL in one action.
- Provide managed HTTPS without asking the user to understand DNS or certificates.
- Preserve Pathway's remote-ready architecture and avoid exposing arbitrary local ports directly to the internet.
- Support normal web development behavior, including HTTP, HTTPS upstreams, streaming responses, Server-Sent Events, WebSockets, and hot-module reload connections.
- Expose the same lifecycle through typed MCP tools so an agent can operate services without shelling around Pathway's ownership model.
- Keep the core model small enough that the first release does not become a container orchestrator or hosting platform.

### Success criteria

- A project service can be declared in `pathway.json` or saved locally from a detected process.
- A user can start a service without entering a port when the process binds to a detectable local port.
- A service started for a thread appears both in the project service list and in the thread context.
- An authenticated remote client can open the preview without enabling public sharing.
- A public share is HTTPS, stable while offline, and displays a clear offline page when the environment or service is unavailable.
- Revoking a share makes the URL unusable without waiting for a local environment to reconnect.
- Archiving a thread stops and unpublishes every run owned by that thread while retaining its reusable definitions.
- The UI never claims a service is live until the relevant runtime and route receipts have landed.
- Aggregate traffic metadata is available for troubleshooting without storing request or response bodies.

## 3. Scope

### Included in v1

- Saved service definitions.
- Project-scoped and thread-scoped service instances.
- Commands with optional working directory and environment-variable references.
- Automatic port detection plus an explicit port fallback.
- Start, stop, restart, archive, reattach, publish, revoke, and copy/open URL actions.
- Adoption of an already detected local development server through **Save as service**.
- Authenticated owner previews through the existing Pathway environment connection.
- Secret public URLs through Pathway Connect and a managed Cloudflare zone.
- Web and desktop UI.
- MCP tools constrained to the agent's current project and thread.
- Bounded read-only logs and observable lifecycle state.
- Configurable safety caps for processes, public shares, idle time, and traffic.

### Explicitly excluded from v1

- Raw TCP or UDP forwarding.
- User-supplied domains.
- User-managed Cloudflare accounts, certificates, or DNS records.
- Production SLAs, autoscaling, replicas, regions, or zero-downtime deployment.
- Container images, Docker Compose, Kubernetes, or a generalized dependency graph.
- Built-in authentication for public visitors beyond possession of the secret URL.
- Per-visitor accounts, access-control lists, password prompts, or Cloudflare Access policies.
- Billing and metered overage.
- Request/response body capture or a LocalCan-style traffic inspector.
- Mobile management UI. Mobile may open an existing URL, but full lifecycle controls are deferred.
- Automatic startup by default. A definition may opt in, but Pathway should not silently launch project processes.

## 4. Domain model and glossary

### Service definition

A durable recipe describing how to run one development service in a project. It includes a stable key, display name, command, working directory, port strategy, optional environment references, and optional defaults. It does not imply that a process is running.

Definitions may come from:

- the repository's `pathway.json`, which is live, version-controlled configuration; or
- Pathway's environment-local state, which is private to that environment.

When both sources contain the same key, local state is an overlay and may override user-editable presentation or runtime fields without rewriting repository configuration. The UI must show the source and effective value.

### Service instance

One runtime allocation of a service definition. An instance has a scope, lifecycle state, process identity, detected endpoint, logs, timestamps, and optional share. A definition may have at most one live instance in each scope. The same definition may therefore run once for the project and separately in multiple threads when their commands and ports permit it.

### Scope

The owner of a service instance:

- `project`: stays alive independently of thread lifecycle.
- `thread`: owned by one thread and stopped when that thread is archived.

Scope is explicit and immutable for a live instance. Reattaching an archived instance creates a new instance in the selected active scope; it does not mutate historical ownership.

### Run

One process execution within an instance. Restarting creates a new run attempt and preserves the previous attempt's terminal status and bounded logs for diagnosis.

### Local endpoint

The loopback or local-machine HTTP(S) address discovered for a running process. It is an implementation detail and is not presented as a durable, separately copyable LAN URL.

### Owner preview

An authenticated preview available to Pathway clients through the existing environment connection. This does not make the service public and should be the default way a user opens their own service remotely.

### Public share

A stable, unguessable HTTPS URL mapping to one service instance. The mapping lives in Pathway's managed gateway so it can be revoked even while the source environment is offline. A share remains allocated until revoked or the instance is archived, but it only proxies traffic while the instance is healthy and connected.

### Disconnect

The Pathway environment or relay session is temporarily unavailable. The public URL remains allocated and returns a branded offline response.

### Stop

Pathway intentionally terminates a run. The definition and instance record remain. A stopped instance's share remains allocated but offline unless the user revokes or archives it.

### Archive

The instance becomes historical and cannot be restarted in place. Its process is stopped and its public route is revoked. Its service definition remains available and the user may explicitly reattach it to a new active scope.

## 5. Architecture decisions

### ADR-001: Separate definitions from runtime instances

Decision: represent a service recipe and its runtime allocation as separate entities.

Why:

- A reusable project recipe should survive process exits, thread archives, and machine restarts.
- One definition may need distinct project and thread instances.
- Runtime facts such as PID, detected port, health, logs, and public routing do not belong in version-controlled project configuration.

Consequences:

- Starting a definition resolves or creates an instance for the requested scope.
- A restart adds a new run attempt to the same active instance.
- Archived instances are historical; reattachment creates a new instance.

### ADR-002: Use repository configuration plus an environment-local overlay

Decision: support `pathway.json.services` as the shareable template and environment-local records for user-created or overridden definitions.

Why:

- Teams can check in obvious service recipes.
- Users and agents can save services without modifying the repository.
- Machine-specific commands, environment references, and ports need not leak into source control.

Consequences:

- Repository edits are watched and become effective on the next start or restart, never by mutating a live run.
- Removing a repository definition does not kill a live instance. It marks that instance's definition as unavailable after the run stops unless a local copy is saved.
- Conflicts use the stable service key and have a deterministic overlay rule.

### ADR-003: Route every preview through the Pathway environment connection

Decision: do not expose a separately managed LAN URL. Local, remote, and public access all originate from an environment-owned preview proxy.

Why:

- It gives web, desktop, and remote clients one transport model.
- It avoids router, firewall, certificate, and hostname setup.
- It preserves Pathway's ability to authenticate owner traffic and mediate public traffic.

Consequences:

- The proxy must preserve method, path, query, headers, response streaming, SSE, and WebSocket upgrades.
- The runtime publishes an internal route keyed by instance ID, not by trusting arbitrary client-supplied host and port pairs.

### ADR-004: Public sharing is explicit and secret-link based

Decision: a service is private to authenticated Pathway clients until a share is created. The first agent request to publish in a project requires user approval; subsequent agent requests may follow the stored project preference.

Why:

- Starting a development server should not silently expose it to the internet.
- A high-entropy URL provides a minimal preview-sharing experience without building an account system for visitors.

Consequences:

- The UI distinguishes **Open preview** from **Publish publicly**.
- Public URLs must not contain project names, thread names, ports, or sequential identifiers.
- The copy action warns that anyone with the link can access the service.
- Revocation rotates/removes the route. Republish creates a new secret URL unless the user explicitly restores the same still-reserved share.

### ADR-005: Use Pathway Connect as the only public-origin transport

Decision: public gateway traffic reaches the environment through Pathway Connect. Direct inbound access to the user's machine is not part of the design.

Why:

- Pathway Connect already exists to make environments remotely reachable.
- An outbound connection works behind NAT and avoids local certificate or firewall configuration.
- It keeps routing authority and environment presence within Pathway's existing remote model.

Consequences:

- Publishing is unavailable until Pathway Connect is configured and connected.
- The UI can guide the user through Connect setup, but must not create an unrelated tunnel stack.
- Relay capacity and framing must evolve from a single app endpoint to multiplexed preview streams.

### ADR-006: Keep public routes durable and authoritative at the gateway

Decision: store share-to-environment routing in a strongly consistent gateway-owned record. Use Cloudflare Durable Objects or an equivalently authoritative store for route state; use Workers KV only for non-authoritative caches if profiling justifies it.

Why:

- Revocation must take effect predictably.
- A URL should retain its identity while an environment is offline.
- Eventually consistent route deletion is a poor security boundary.

Consequences:

- The gateway can return offline, revoked, rate-limited, or not-found responses without contacting the environment.
- Route records contain opaque IDs and routing metadata, never user commands or environment secrets.

### ADR-007: Treat this as preview hosting

Decision: optimize for development servers and demonstrations, not production workloads.

Why:

- Long-lived local processes are inherently dependent on one user's machine and network.
- A production-hosting promise would require a different execution, security, billing, and operations model.

Consequences:

- Public pages and UI copy say **preview**, not deploy or production.
- Configurable limits and idle policies may interrupt abusive or abandoned traffic.
- No production SLA is implied.

### ADR-008: Make lifecycle changes event-sourced and receipt-driven

Decision: service commands are decided into durable events, projected into read models, and completed through typed runtime and gateway receipts.

Why:

- This matches Pathway's command/event/projector/reactor architecture.
- Clients need truthful intermediate states across restarts and remote connections.
- External side effects such as process spawn and route allocation must be reconciled, not assumed synchronous.

Consequences:

- UI states include requested/transitional states and only become live after receipts.
- Recovery workers reconcile incomplete spawn, stop, publish, and revoke operations after server restart.

## 6. `pathway.json` contract

Suggested shape:

```json
{
  "services": {
    "web": {
      "name": "Web app",
      "command": "bun run dev",
      "cwd": ".",
      "port": "detect",
      "autoStart": false
    },
    "docs": {
      "name": "Documentation",
      "command": "bun run docs -- --port $PORT",
      "cwd": "apps/docs",
      "port": {
        "strategy": "allocated",
        "environmentVariable": "PORT"
      },
      "environment": {
        "NODE_ENV": "development"
      }
    },
    "api": {
      "name": "API",
      "command": "bun run api",
      "cwd": ".",
      "port": 4310,
      "healthPath": "/health"
    }
  }
}
```

### Definition fields

```ts
type ProjectServiceConfig = {
  name?: string;
  command: string;
  cwd?: string;
  port?:
    | number
    | "detect"
    | {
        strategy: "detect" | "fixed" | "allocated";
        value?: number;
        environmentVariable?: string;
      };
  protocol?: "http" | "https";
  healthPath?: string;
  environment?: Record<string, string>;
  autoStart?: boolean;
};
```

### Contract rules

- The object key is the stable definition key and must be unique within a project.
- `command` is required and is executed by the environment's established project-command runner. It is not interpreted by clients.
- `cwd` is resolved beneath the project root. Escaping the project root is rejected unless a future explicit permission model allows it.
- `port: "detect"` is the default.
- A fixed port is validated before spawn and produces an actionable conflict if already occupied.
- An allocated port is reserved by Pathway and injected through the configured environment variable, defaulting to `PORT`.
- `protocol` describes the local upstream. The externally exposed URL is always HTTPS.
- `environment` contains non-secret literal values only. Secret values must use the existing environment/secret reference mechanism rather than being serialized into `pathway.json` or service events.
- `autoStart` defaults to `false`. When enabled, it applies to the project-scoped instance only and still respects environment safety caps.
- Edits to the file update the definition projection immediately but affect a running process only on its next restart.
- Unknown fields are reported clearly and preserved only if Pathway's existing project-file policy already supports forward-compatible preservation.

## 7. Public contracts

The exact schema syntax should follow `packages/contracts`, but the semantic types are:

```ts
type ServiceDefinitionId = string;
type ServiceInstanceId = string;
type ServiceRunId = string;
type ServiceShareId = string;

type ServiceDefinitionSource =
  | { type: "project-file"; key: string }
  | { type: "environment-local" };

type ServiceDefinition = {
  id: ServiceDefinitionId;
  projectId: string;
  key: string;
  name: string;
  source: ServiceDefinitionSource;
  command: string;
  cwd: string;
  port: ServicePortStrategy;
  protocol: "http" | "https";
  healthPath?: string;
  autoStart: boolean;
  createdAt: string;
  updatedAt: string;
};

type ServiceScope =
  | { type: "project"; projectId: string }
  | { type: "thread"; projectId: string; threadId: string };

type ServiceInstanceStatus =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "archiving"
  | "archived";

type ServiceEndpoint = {
  protocol: "http" | "https";
  host: "127.0.0.1" | "localhost" | "::1";
  port: number;
  detectedAt: string;
};

type ServiceInstance = {
  id: ServiceInstanceId;
  definitionId: ServiceDefinitionId;
  scope: ServiceScope;
  status: ServiceInstanceStatus;
  activeRunId?: ServiceRunId;
  endpoint?: ServiceEndpoint;
  ownerPreviewUrl?: string;
  failure?: ServiceFailure;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

type ServiceRun = {
  id: ServiceRunId;
  instanceId: ServiceInstanceId;
  attempt: number;
  status: "requested" | "spawning" | "running" | "exited" | "failed" | "stopped";
  exitCode?: number;
  signal?: string;
  startedAt?: string;
  endedAt?: string;
};

type ServiceShareStatus = "publishing" | "online" | "offline" | "revoking" | "revoked" | "failed";

type ServiceShare = {
  id: ServiceShareId;
  instanceId: ServiceInstanceId;
  status: ServiceShareStatus;
  publicUrl: string;
  hostnameToken: string;
  createdBy: { type: "user" | "agent"; id?: string };
  createdAt: string;
  revokedAt?: string;
  lastRequestAt?: string;
  requestCount?: number;
  byteCount?: number;
};
```

### Capability contract

Clients need an environment capability record so controls are honest:

```ts
type DevelopmentServicesCapability = {
  supported: boolean;
  processManagement: boolean;
  ownerPreview: boolean;
  publicSharing: boolean;
  publicSharingReason?:
    | "connect-not-configured"
    | "connect-offline"
    | "gateway-unavailable"
    | "policy-disabled"
    | "unsupported-version";
  limits: {
    maxRunningServices: number;
    maxPublicShares: number;
    maxLogBytesPerRun: number;
  };
};
```

## 8. Commands, events, projections, and receipts

### Commands

- `serviceDefinition.saveLocal`
- `serviceDefinition.removeLocal`
- `serviceDefinition.importFromAction`
- `serviceDefinition.adoptDetectedServer`
- `serviceInstance.start`
- `serviceInstance.stop`
- `serviceInstance.restart`
- `serviceInstance.archive`
- `serviceInstance.reattach`
- `serviceShare.publish`
- `serviceShare.revoke`
- `serviceLogs.read`

Every mutation carries the current environment/project identity, expected entity version where relevant, actor, and idempotency key.

### Durable events

- `ServiceDefinitionSaved`
- `ServiceDefinitionRemoved`
- `ServiceInstanceCreated`
- `ServiceStartRequested`
- `ServiceSpawnSucceeded`
- `ServiceEndpointDetected`
- `ServiceBecameHealthy`
- `ServiceStopRequested`
- `ServiceProcessExited`
- `ServiceFailed`
- `ServiceArchiveRequested`
- `ServiceArchived`
- `ServiceReattached`
- `ServicePublishRequested`
- `ServiceShareAllocated`
- `ServiceShareBecameOnline`
- `ServiceShareBecameOffline`
- `ServiceRevokeRequested`
- `ServiceShareRevoked`

Event payloads contain logical identities and outcomes, not operating-system process handles, raw secrets, or unbounded log output.

### Projections

- Project service definitions, merged from project-file and local sources.
- Active service instances grouped by project and thread.
- Recent archived instances for reattachment/history.
- Current run summary and bounded log cursor.
- Share state and aggregate traffic metadata.
- Environment capability and limits.

### Side-effect receipts

Runtime and gateway reactors emit typed receipts for:

- process spawned;
- endpoint detected;
- health check passed or detection timed out;
- process stopped or exited;
- route allocated;
- route activated;
- route marked offline;
- route revoked;
- cleanup completed.

Clients render the projected state. They do not infer success from a command acknowledgement alone.

## 9. Runtime process manager

### Responsibilities

- Validate the effective definition and scope.
- Enforce process and port limits.
- Resolve the working directory beneath the project root.
- Spawn the command as a managed process group.
- Capture stdout and stderr into a bounded ring buffer.
- Detect the listening HTTP endpoint.
- Optionally probe the health path.
- Register the instance with the environment preview proxy.
- Stop the full process group using Pathway's safe owned-process mechanism.
- Reconcile orphaned runtime state after Pathway server restart.

### Port strategies

#### Detect

1. Snapshot listening loopback TCP ports owned by the environment before spawn.
2. Spawn the owned process group.
3. Observe new listeners attributable to that process group.
4. Parse common development-server URL output as supporting evidence, not as the only source of truth.
5. Prefer a listener that answers HTTP(S) and matches an emitted URL.
6. If exactly one viable endpoint exists, select it.
7. If several exist, present candidates and require a user/agent selection or an explicit fixed port.
8. If none appears before the bounded detection deadline, keep the process state truthful and mark endpoint detection failed with remediation.

The existing port scanner can seed this work, but detection must add process ownership and lifecycle correlation before it is safe to route publicly.

#### Fixed

Validate the configured port before spawn. If another process owns it, fail without killing or adopting that process. Offer **Save existing server as service** only after the user explicitly chooses the detected process.

#### Allocated

Reserve an available loopback port, inject it through the configured environment variable, and release the reservation immediately before the child binds. If the command ignores the allocation and binds elsewhere, detection may discover the actual endpoint but the run records a configuration warning.

### Process ownership

- Store the spawn handle and process-group identity only in runtime state.
- Never find a process to stop by fuzzy command, path, or name matching.
- Stop only a process group Pathway itself spawned and still owns.
- An adopted server is observable and routable but cannot be terminated until Pathway can prove ownership. Its stop action disconnects the route and explains that the external process remains alive.

### Crash behavior

- Unexpected exit moves the run and instance to `failed`.
- The public URL remains allocated but reports offline.
- Pathway does not automatically restart crashes in v1.
- The user or agent may explicitly restart.
- Logs retain the bounded tail necessary to diagnose the exit.

### Server restart recovery

On Pathway server startup:

- Treat persisted `starting`, `running`, `stopping`, `publishing`, and `revoking` states as reconciliation candidates.
- Reconnect only to processes whose ownership can be proven. Otherwise mark the old run failed/stopped and require a fresh start.
- Mark associated gateway routes offline until the environment re-registers a healthy endpoint.
- Re-run opted-in project auto-start definitions after normal environment readiness, subject to limits.

## 10. Lifecycle rules

| Trigger                     | Process                      | Owner preview        | Public share            | Definition/history                       |
| --------------------------- | ---------------------------- | -------------------- | ----------------------- | ---------------------------------------- |
| User stops instance         | Stop owned process           | Offline              | Retained, offline       | Retained                                 |
| User restarts instance      | New run attempt              | Returns when healthy | Same URL returns online | Retained                                 |
| Process crashes             | Exited, status failed        | Offline              | Retained, offline       | Retained with logs                       |
| Environment disconnects     | Unknown until reconciliation | Offline              | Retained, offline page  | Retained                                 |
| Thread is archived          | Stop thread-owned processes  | Removed              | Revoked                 | Definition retained; instance archived   |
| Project is archived/removed | Stop project processes       | Removed              | Revoke all              | Follow project retention policy          |
| User archives instance      | Stop process                 | Removed              | Revoked                 | Instance historical; definition retained |
| User revokes share          | Unchanged                    | Unchanged            | Revoked immediately     | Retained                                 |
| `pathway.json` changes      | Current run unchanged        | Unchanged            | Unchanged               | Effective on next restart                |
| Definition removed          | Current run may finish       | Remains for run      | Remains for run         | Save locally or unavailable after stop   |

Thread archive must issue one idempotent archive command per owned instance and wait for its cleanup receipts as part of the archive workflow. Failures remain visible and retryable; the UI must not imply public access is gone until gateway revocation is confirmed.

## 11. Environment preview proxy

Each Pathway environment hosts a preview proxy beside the existing server transport.

### Route identity

The proxy accepts only an authenticated internal instance route, for example:

```text
/api/previews/{serviceInstanceId}/{remainingPath}
```

The server resolves `serviceInstanceId` to the currently projected endpoint. Clients cannot provide an arbitrary target host or port.

### Required behavior

- Preserve HTTP method, path, query string, request body, status, and streaming response body.
- Forward WebSocket upgrade frames bidirectionally.
- Preserve SSE flush behavior.
- Rewrite only routing headers required for the local upstream.
- Add standard forwarded headers with a Pathway-controlled trust boundary.
- Strip hop-by-hop headers correctly.
- Do not forward Pathway authentication, Connect credentials, or gateway control headers to the local service.
- Apply request size, header size, connection, and idle limits.
- Bind local upstream access to loopback by default.
- Reject endpoints that resolve to arbitrary network hosts in v1.

### Owner preview

Owner preview requests use normal Pathway authentication and authorization, resolve the selected environment and project, and then traverse the same internal route. The client receives a Pathway URL rather than a raw `localhost:{port}` URL, which makes the experience consistent when the user is remote.

### Browser-origin behavior

Development tools frequently assume a stable origin and WebSocket-compatible host. The proxy should preserve one preview origin per instance and support:

- relative assets and navigation;
- Vite/Next/Webpack hot reload;
- cookies scoped to the preview host;
- redirects from the upstream;
- absolute `localhost` redirects where safe rewriting is possible.

Host-header behavior should be configurable only if real frameworks require it. The v1 default should send the preview hostname through `X-Forwarded-Host` while using a local host header accepted by common dev servers.

## 12. Cloudflare Preview Gateway

### Topology

```text
Public browser
  -> wildcard DNS under Pathway's managed preview domain
  -> Cloudflare Worker route
  -> authoritative share route record
  -> Pathway Connect relay
  -> target environment preview proxy
  -> loopback development service
```

Cloudflare does not support wildcard Worker Custom Domains. Use wildcard DNS in the managed zone plus a Worker Route matching the preview hostname pattern.

### Managed resources

- A dedicated preview subdomain, separate from primary application traffic.
- Wildcard DNS record controlled by Pathway.
- Worker route for the wildcard hostname.
- Gateway Worker for HTTP, streaming, and WebSocket upgrade handling.
- Durable Object namespace, or equivalent strongly consistent store, for authoritative share routes and revocation.
- Analytics Engine dataset for aggregate gateway metrics if operationally useful.
- Workers Rate Limiting rules or equivalent controls for abuse and safety caps.

### Hostname format

Use a friendly adjective/noun prefix plus a cryptographically random token, for example:

```text
silver-otter-k7m4p2.preview.pathway.example
```

The friendly segment is cosmetic. Security comes from at least 128 bits of unguessable entropy in the complete route token. Do not derive it from project, user, environment, thread, or service identifiers.

### Authoritative route record

```ts
type PublicPreviewRoute = {
  shareId: ServiceShareId;
  hostnameTokenHash: string;
  environmentId: string;
  projectId: string;
  instanceId: ServiceInstanceId;
  state: "online" | "offline" | "revoked";
  relayTargetId?: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  policy: {
    maxConcurrentConnections: number;
    maxRequestBytes: number;
    maxResponseBytes?: number;
    idleTimeoutSeconds: number;
  };
};
```

Store only what is needed to route and enforce policy. Commands, logs, repository paths, thread content, and upstream request bodies do not belong here.

### Request flow

1. Parse and validate the hostname token.
2. Resolve its authoritative route record.
3. Return `404` for unknown or revoked tokens without revealing prior existence.
4. Apply rate and concurrency policy.
5. If the route or environment is offline, return a cache-disabled branded `503` preview-offline page.
6. For an online route, open or reuse an authorized multiplexed Connect stream to the environment.
7. Proxy HTTP or upgrade to WebSocket.
8. Emit aggregate request count, bytes, latency, response class, and last-request time.

### Offline behavior

- The public hostname remains stable after stop, crash, or temporary disconnect.
- It returns a small Pathway offline page with no private project or user details.
- It sends `Cache-Control: no-store` so a restarted service becomes reachable promptly.
- Revoke removes the authoritative mapping and changes the response to generic not found.

### TLS

Cloudflare terminates public HTTPS for Pathway's managed zone. The Connect leg uses Pathway's authenticated encrypted transport. The final environment-to-service hop is loopback HTTP or HTTPS according to the definition. Users do not manage certificates.

## 13. Pathway Connect and relay changes

The existing tunnel appears oriented around one Pathway application endpoint. Preview sharing requires multiplexed routes without opening new machine ports.

### New relay concepts

- An environment advertises preview capability after authenticated Connect registration.
- A gateway opens a stream addressed by `environmentId + serviceInstanceId`, never by raw host/port.
- The environment validates the instance is active, shareable, and mapped to a healthy loopback endpoint.
- One Connect session supports multiple concurrent HTTP and WebSocket streams.
- Backpressure and cancellation propagate end to end.
- Environment disconnect atomically marks its active shares offline at the gateway or expires their online lease promptly.

### Control operations

```ts
type PreviewGatewayControl =
  | {
      type: "allocate";
      shareId: string;
      environmentId: string;
      instanceId: string;
      policy: SharePolicy;
    }
  | { type: "activate"; shareId: string; relayTargetId: string }
  | { type: "offline"; shareId: string; reason: string }
  | { type: "revoke"; shareId: string }
  | { type: "heartbeat"; environmentId: string; activeShareIds: string[] };
```

Control operations are authenticated service-to-service calls and idempotent by share ID plus operation version.

### Data-plane envelope

The relay protocol needs typed stream open/data/end/error frames carrying:

- route/instance identity;
- HTTP request metadata or WebSocket upgrade metadata;
- bounded header blocks;
- binary body frames;
- half-close/cancel semantics;
- flow-control credit or an equivalent backpressure mechanism.

Do not serialize entire streaming requests or responses into one WebSocket message or persist payloads in the event store.

## 14. Limits, privacy, and security posture

### Defaults

Initial defaults should be conservative and server-configurable rather than hard-coded into clients. Suggested starting values for product validation:

- 5 running service instances per environment.
- 3 public shares per environment.
- 10 MiB retained combined stdout/stderr per run, implemented as a bounded tail.
- 100 concurrent public connections per share, with a materially lower WebSocket cap if needed.
- 25 MiB request body limit.
- 60-minute connection idle ceiling, with protocol-aware keepalive behavior.

These numbers are rollout defaults, not contract guarantees. Measure before raising them.

### Public-link warning

Publishing displays a concise warning:

> Anyone with this secret link can access whatever this development service exposes. Do not publish services containing sensitive data or privileged developer tools.

### Agent approval

- Starting or stopping a service is allowed within the current thread/project capability.
- The first agent-initiated public publish in a project requires an explicit user confirmation in Pathway.
- The approval stores a project-level preference that can be revoked in Settings.
- The agent never receives Connect credentials or gateway control tokens.
- MCP results may return the resulting public URL after approval.

### Request privacy

Store only aggregate metadata needed for UI and operations:

- request count;
- bytes in/out;
- response status class;
- coarse latency;
- concurrent connection count;
- last request time.

Do not retain URLs with sensitive query strings, headers, cookies, bodies, response content, or WebSocket messages. Application access logs remain the responsibility of the local service and its bounded process output.

### SSRF boundary

- Only route to an endpoint registered by the owned service runtime.
- v1 endpoints are loopback only.
- Never accept an arbitrary URL from the public gateway, client RPC, or MCP tool.
- Revalidate endpoint ownership on every run and when restoring state.
- Strip internal authorization headers before forwarding.

## 15. Web and desktop UX

### Information architecture

Keep **Development Environments → Services** as the canonical project-wide list. It already provides the right mental model: all services available in this environment/project.

Add a compact **Services** section in an active thread for instances scoped to that thread. It links to the canonical service details rather than creating a separate model.

### Project service list

Each row shows:

- service name and definition source;
- scope badge: Project or thread name;
- state: Starting, Running, Stopped, Failed, or Archived;
- detected endpoint as secondary diagnostic text;
- owner preview action;
- public share state and copy action;
- last exit/failure summary when relevant.

Primary actions depend on state:

- Definition only: **Start**.
- Running: **Open preview**, **Restart**, **Stop**.
- Private running: **Publish publicly**.
- Shared: **Copy public link**, **Revoke link**.
- Failed: **View logs**, **Restart**.
- Stopped: **Start**, **Archive**.
- Archived: **Reattach**.

### Create service

The form asks only for:

- name;
- command;
- working directory, default project root;
- port, default Detect automatically;
- scope, default Current thread when opened from a thread and Project when opened from the environment area.

Advanced fields contain protocol, health path, environment references, allocated/fixed port behavior, and auto-start.

If a currently detected development server is not saved, show **Save as service** with the detected command/process evidence and port. Adoption does not imply termination ownership.

### Public sharing flow

1. User selects **Publish publicly**.
2. If Connect is unavailable, Pathway opens the existing Connect setup flow and explains why it is required.
3. Show the secret-link warning.
4. Allocate the share and display a publishing state.
5. Only after the gateway activation receipt, show the URL and copy/open controls.
6. Show a persistent **Public** badge and a one-click revoke action.

Do not show DNS, TLS, Worker, relay, or certificate configuration in the normal flow.

### Thread archive flow

If the thread owns active services, the archive confirmation says how many will be stopped and how many public links will be revoked. Archiving proceeds through the existing workflow and reports any cleanup failure with retry. Archived service definitions remain available under project services and can be explicitly reattached.

### Logs

- Read-only stdout/stderr tail.
- Clear separation between current and prior run attempts.
- Follow mode only while visible; no continuously repainting animation.
- Load older retained chunks on demand up to the configured bound.
- Copy diagnostic text without leaking stored environment secrets.

### Multi-surface decision

- Web: complete management and preview experience.
- Desktop: complete experience through the shared web UI plus existing Electron environment host behavior.
- Mobile: no new management UI in v1. Existing URLs can open in the platform browser; contracts should avoid preventing a later native surface.

## 16. MCP toolkit

Add a development-services toolkit in the server MCP surface.

### Tools

```text
services_list
services_get
service_save
service_start
service_stop
service_restart
service_archive
service_reattach
service_logs
service_publish
service_revoke_share
```

### Scoping

- Tools derive environment, project, and current thread from the MCP session.
- Agents may list project definitions and instances, but mutations are limited to the current project.
- A thread-scoped agent may start or mutate only current-thread instances unless the user has explicitly granted a broader future capability.
- The agent cannot name an arbitrary thread ID to operate elsewhere.
- Project-scoped start is available only when the tool invocation explicitly requests it and the current session capability allows it.

### Publish approval

`service_publish` may return:

```ts
type PublishResult =
  | { status: "published"; share: ServiceShare }
  | { status: "approval-required"; approvalId: string; message: string }
  | { status: "connect-required"; message: string };
```

The approval is completed in Pathway, then the original idempotent operation resumes or the agent retries with the same operation key.

### Tool output

Keep output bounded and structured. Logs accept `tailLines`/cursor limits. List results return summaries, not full log bodies or historical events.

## 17. Client RPC and subscriptions

Suggested requests:

```text
developmentServices.list
developmentServices.saveDefinition
developmentServices.removeDefinition
developmentServices.start
developmentServices.stop
developmentServices.restart
developmentServices.archive
developmentServices.reattach
developmentServices.publish
developmentServices.revokeShare
developmentServices.readLogs
developmentServices.approveAgentPublishing
```

Suggested subscription/projected payload:

```ts
type DevelopmentServicesSnapshot = {
  projectId: string;
  definitions: ServiceDefinition[];
  activeInstances: ServiceInstance[];
  recentArchivedInstances: ServiceInstance[];
  runsByInstance: Record<string, ServiceRunSummary>;
  sharesByInstance: Record<string, ServiceShare>;
  capability: DevelopmentServicesCapability;
  revision: number;
};
```

Use incremental events or the repository's established projection subscription pattern so logs and traffic counters do not cause full project snapshots to repaint. Logs should have a separate cursor-based channel.

## 18. Failure handling

### Start failures

- Invalid cwd or command: fail before spawn with field-level remediation.
- Port occupied: identify the port and offer detection/adoption without killing anything.
- No port detected: keep logs, mark failed or running-without-endpoint according to actual process state, and allow the user to choose a port.
- Process exits before endpoint: show exit code and log tail.

### Proxy failures

- Upstream refused connection: mark the current health observation failed; return `502` to the requester.
- Upstream timeout: return `504`; do not immediately declare the process dead.
- Unsupported upgrade/protocol: return a precise error and record aggregate failure telemetry.
- Oversized request: return `413` at the earliest boundary.

### Connect failures

- Connect not configured: public publish is blocked with a setup action; owner local preview may still work.
- Temporary disconnect: route remains allocated and offline.
- Reconnect: environment heartbeats and instance validation restore online state.
- Stale relay lease: gateway fails closed to offline rather than routing to another environment.

### Gateway failures

- Allocation fails: instance remains private and healthy; publish status becomes failed/retryable.
- Activation receipt is lost: reconciliation queries authoritative share state using its idempotency key.
- Revocation fails: show `revoking`, retry in the reactor, and do not claim success.
- Gateway cannot be reached during thread archive: stop the local process, retain a cleanup obligation, and keep the thread archive result visibly incomplete until revocation succeeds.

## 19. Migration and compatibility

- Existing project Actions/Project Scripts remain unchanged.
- Add **Import as service** for a long-running action rather than silently reclassifying actions.
- A service definition may reuse the same command as an action but has its own identity and lifecycle.
- Existing discovered-port UI continues working while the new service projection is introduced.
- Add **Save as service** to bridge a discovered server into the managed model.
- Older clients ignore the new service capability and continue using existing environment controls.
- New clients hide unsupported controls when connected to an older server.
- Contract schema changes are versioned and additive for the first release.
- No existing local URL or project action is automatically made public.

## 20. Implementation plan

### Slice 1: Definitions and local process lifecycle

Deliver:

- Contract schemas and IDs.
- `pathway.json.services` parsing, validation, watching, and merged local overlay.
- Service commands, events, projections, and persistence.
- Owned process manager with bounded logs.
- Fixed, allocated, and detected port strategies.
- Project service list and create/edit/start/stop/restart UI.
- Focused server tests for lifecycle, ownership, port conflicts, file updates, and restart reconciliation.

Exit condition: a web/desktop user can save and reliably run a private local service, inspect its state/logs, and stop it without affecting unrelated processes.

### Slice 2: Thread ownership and archive integration

Deliver:

- Project/thread scope contracts and UI.
- Thread-context service section.
- Archive cleanup commands and receipts.
- Archived-instance history and explicit reattachment.
- Tests for multi-thread instances, archive races, idempotency, and partial cleanup failures.

Exit condition: thread-owned services have an unsurprising lifecycle and cannot remain publicly or locally active after successful archive cleanup.

### Slice 3: Authenticated owner preview proxy

Deliver:

- Instance-addressed environment proxy.
- Authenticated preview URLs for local and remote Pathway clients.
- HTTP, streaming, SSE, redirect, cookie, and WebSocket support.
- Capability negotiation for older servers/clients.
- Focused integration fixtures for Vite-style HMR and streaming.

Exit condition: a user connected remotely to Pathway can open a private development service without using a LAN address.

### Slice 4: Connect multiplexing and Cloudflare gateway

Deliver:

- Multiplexed preview streams in Connect/relay.
- Gateway Worker, wildcard DNS/route, authoritative route state, and control API.
- Stable secret hostnames, online/offline/revoked states, TLS, and limits.
- Aggregate gateway telemetry.
- Reconciliation and heartbeat behavior.
- End-to-end tests using a non-production preview zone.

Exit condition: a healthy service can be reached through a stable HTTPS public URL and fails closed/offline when its environment disconnects.

### Slice 5: Public-sharing UX and approvals

Deliver:

- Publish, copy, open, revoke, and offline UI.
- Connect prerequisite flow.
- Agent first-publish approval and project preference.
- Thread archive share warnings and confirmed revocation state.
- User-facing docs and operational support states.

Exit condition: a user can safely share a concept site without seeing infrastructure configuration, and can reliably revoke it.

### Slice 6: MCP and adoption workflow

Deliver:

- Current-thread-scoped MCP toolkit.
- Structured bounded logs and status output.
- Approval-aware publish results.
- **Save as service** for detected external servers.
- **Import as service** from existing project actions.
- Audit events for actor attribution.

Exit condition: an agent can create and operate a service for its current work, while public exposure remains under visible user control.

## 21. Test plan

### Contracts

- Decode valid project-file definitions and reject invalid cwd, port, protocol, and environment shapes.
- Backward-compatible snapshot decoding for clients without service support.
- Round-trip every command, event, receipt, and projection variant.

### Decider/projector

- Start is idempotent per definition and scope.
- Same definition may run in project and multiple thread scopes, but only once per exact scope.
- Invalid state transitions are rejected.
- Crash remains failed until explicit restart.
- Stop retains share offline; archive revokes it.
- Thread archive creates cleanup work for every owned instance.
- Reattachment creates a new instance and retains history.

### Runtime

- Detect one attributable HTTP listener.
- Resolve ambiguous listeners explicitly.
- Handle fixed-port collision without killing the owner.
- Allocate and inject a port.
- Stop only a captured owned process group.
- Adopted external service disconnects without termination.
- Bound stdout/stderr memory and cursor reads.
- Reconcile server restart without claiming unknown processes are alive.

### Proxy

- Methods, paths, query parameters, headers, bodies, status, and redirects.
- Chunked response streaming and SSE flush.
- WebSocket upgrade and bidirectional binary/text frames.
- HMR fixture through the preview origin.
- Cookie isolation across two preview hostnames.
- Request size, timeout, cancellation, and backpressure.
- Rejection of arbitrary target endpoints and leaked auth headers.

### Gateway and relay

- Allocate, activate, offline, reconnect, revoke, and republish.
- Revocation is immediately authoritative.
- Unknown and revoked routes do not disclose metadata.
- Environment A cannot register or consume environment B's route.
- Multiple service streams share one Connect session.
- WebSockets survive normal relay traffic and close cleanly on disconnect.
- Rate/concurrency limits and offline page behavior.
- No request/response content in logs or analytics.

### UI

- Project and thread list states.
- First agent publish approval.
- Connect-not-configured guidance.
- Copy/open/revoke states only after receipts.
- Thread archive warning and failure recovery.
- Project-file edit marked for next restart.
- Older server capability fallback.

## 22. Acceptance scenarios

### User starts and shares a concept site

Given a project with a `web` service definition, when the user starts it from Development Environments, Pathway detects its port and shows Running. **Open preview** works for the authenticated user. When the user selects **Publish publicly**, accepts the warning, and Pathway Connect is online, Pathway returns a stable HTTPS URL. A browser with no Pathway session can load the site, including assets and HMR WebSocket traffic.

### Agent starts a thread service

Given an active thread, an agent calls `service_start` for a saved definition with thread scope. The instance appears in the project list and thread section. The agent can read bounded logs and open the owner preview. On its first `service_publish`, the tool returns approval required. After user approval, retrying the idempotent call returns the public URL.

### Thread is archived

Given two running services owned by a thread and one project-owned service, archiving the thread stops only the two thread services, revokes their public routes, retains their definitions and history, and leaves the project service running. Reattaching one definition to a new thread creates a new instance and, if published, a new secret URL.

### Machine goes offline

Given a published running service, when the environment disconnects, the same URL returns Pathway's no-store offline page. When the environment reconnects and validates the same healthy instance, the URL resumes proxying without user reconfiguration.

### Service crashes

Given a shared service whose process exits unexpectedly, its instance becomes Failed, the share remains allocated but Offline, and the user sees the exit summary and logs. Pathway does not auto-restart it. Explicit Restart launches a new run and restores the same share when healthy.

### Share is revoked while the environment is offline

Given an allocated share and an offline source environment, the user revokes the share through another authenticated Pathway surface. The gateway's authoritative route becomes revoked and the old URL returns generic not found. Reconnecting the environment cannot reactivate that share.

## 23. Rollout and monitoring

### Feature gates

- Server capability gate for managed services.
- Separate gate for owner preview proxy.
- Separate server and gateway gate for public sharing.
- Project/environment policy toggle to disable public sharing.

### Phased rollout

1. Maintainer-only local service lifecycle.
2. Private owner previews over remote connections.
3. Internal Cloudflare preview zone with strict caps.
4. Opt-in public beta for desktop/web hosts using Pathway Connect.
5. Broader availability after relay capacity, abuse, failure, and cost data are understood.

### Operational signals

- Active processes and process start/exit failures.
- Port detection success and ambiguity rate.
- Active public shares and share allocation/revocation failures.
- Gateway request rate, bytes, latency, status class, WebSocket count, and limit rejections.
- Connect stream open failures, concurrent streams, backpressure, and disconnects.
- Offline-route duration and stale-online lease prevention.
- Cleanup obligations older than the expected retry window.

Avoid high-cardinality labels containing public tokens, project paths, commands, or user content.

## 24. Documentation changes

### User documentation

- Creating and running a development service.
- Difference between owner preview and public preview.
- Sharing and revoking a secret link.
- What happens when a service stops, crashes, disconnects, or its thread is archived.
- Connect prerequisite and preview-hosting limitations.
- Safety guidance for services containing sensitive data.

### Internal documentation

- Add the glossary terms from this plan to `docs/internals/glossary.md`.
- Document process ownership, port detection, and preview proxy boundaries.
- Document Connect multiplexing and gateway route lifecycle.
- Add an operations runbook for gateway degradation, stuck revocation, abuse response, and preview-zone rollback.

## 25. Explicit defaults and assumptions

- The canonical product term is **development service**; **preview** describes how a service is accessed.
- The existing Services area remains the project-wide home rather than introducing another top-level section.
- A definition is durable; an instance is scoped runtime state; a run is one process attempt.
- Thread archive stops and archives thread-owned instances and revokes their shares.
- Stopping alone leaves a share allocated but offline so restarting restores the same URL.
- A user must explicitly reattach an archived service; Pathway does not guess the next thread.
- Repository definitions are live templates, and changes apply on next restart.
- Project Actions remain separate but can be imported as service definitions.
- Public URLs are stable secret links valid until revoked or archived.
- Public publishing requires Pathway Connect and Pathway's managed Cloudflare zone.
- Cloudflare provides public TLS; users handle no certificates.
- The public gateway supports HTTP(S) development apps, streaming, SSE, WebSockets, and HMR, but not arbitrary TCP.
- Authenticated owner preview is separate from public sharing.
- Agent mutations are limited to the current project/thread, and first public publish requires user approval.
- Crashes remain failed until an explicit restart.
- Logs are bounded and read-only.
- Traffic observability is aggregate only.
- Safety caps are configurable and launch without billing.
- Web and desktop ship first; mobile lifecycle management is deferred.
- This feature is explicitly preview-grade long-lived hosting from a user's machine, not production deployment.

## 26. Reference notes

Cloudflare constraints and capabilities that shape the gateway design:

- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) — wildcard custom domains are not supported, so the preview gateway should use wildcard DNS plus a Worker Route.
- [Workers Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/) — route patterns can bind the Worker to the managed preview hostname space.
- [Durable Objects](https://developers.cloudflare.com/durable-objects/) — suitable for strongly consistent coordination and authoritative per-share state.
- [Workers KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/) — KV is eventually consistent and should not be the revocation authority.
- [Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/) and [Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/) — required proxy behaviors are supported by the Worker runtime.
