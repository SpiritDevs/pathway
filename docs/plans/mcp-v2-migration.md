# MCP v2 migration (2026-07-28)

Status: agreed design, not yet implemented.
Prerequisite for [local SMTP capture](./local-smtp-capture.md).

Move Pathway's MCP server from the current stateful protocol to MCP
`2026-07-28`. Hard cutover — the old version is removed, not kept alongside.

The immediate driver is push: local SMTP capture needs to tell a waiting agent
that mail arrived without that agent polling. v2's tasks extension and
`subscriptions/listen` are the mechanisms for that. Statelessness and the auth
hardening come along with it.

## Why the current server can't do it

`apps/server/src/mcp/McpHttpServer.ts` builds on Effect's
`effect/unstable/ai` (`McpServer`, `McpProtocol`, `McpSchema`), not the official
SDK. That implementation is structurally v1 — it is built around the
`initialize` handshake and the session state it establishes:

- `McpSchema.ts:711` — `initialize` RPC
- `McpSchema.ts:740` — `notifications/initialized`
- `McpServer.ts:434-452` — requests rejected unless the client has initialized
- `McpServer.ts:348` — `clientSessions` keyed per client

v2 removes the handshake outright. There is no `server/discover`, no
`subscriptions/listen`, and no tasks extension in the Effect implementation.
`.repos/` is vendored read-only per AGENTS.md, so it can't be patched here.

## Decision

Migrate wholesale to the official v2 SDK. v2 only. The v1 path is deleted.

**Package correction (learned the hard way):** the v2 SDK is NOT
`@modelcontextprotocol/sdk` — that package is the v1 line and tops out at
protocol `2025-11-25`. For v2 the TypeScript SDK split into
`@modelcontextprotocol/server` and `@modelcontextprotocol/client`, both at
2.0.0 stable, published by Anthropic from the typescript-sdk main branch.
Verified in the published bundle: `2026-07-28`, `server/discover`, and
`subscriptions/listen` are present. Effect's own `effect/unstable/ai` McpServer
was also evaluated as a v2 vehicle and rejected: even `4.0.0-rc.108` speaks
only `2025-06-18` and is still initialize-based.

Rejected: dual-version, and hand-rolling v2 on the Effect RPC layer. The
maintainer's call is a clean cutover on the basis that Codex and Claude — the
providers that matter here — both support `2026-07-28`.

### Provider decisions

AGENTS.md requires a decision per adapter, even when the decision is "not
supported here".

| Provider | Status                                                                         |
| -------- | ------------------------------------------------------------------------------ |
| Claude   | Supported. First major client to ship `2026-07-28`.                            |
| Codex    | Supported, per maintainer. Worth a connect-and-confirm at implementation time. |
| Cursor   | Unverified. Known gap until their client ships v2.                             |
| OpenCode | Unverified. Known gap until their client ships v2.                             |
| Grok     | Unverified. Known gap until their client ships v2.                             |

A provider that can't negotiate v2 loses all Pathway MCP tools, including
`preview_*`, which the browser and simulator skills depend on. That is the
accepted cost of the cutover.

## What this migration is cheaper than it looks

`McpSessionRegistry` is **not** an MCP protocol session. It's Pathway's own
credential registry, binding a bearer token to a `threadId` and
`providerInstanceId` (`McpSessionRegistry.ts:14-27`). Pathway already
authenticates every MCP request independently from a bearer token, which is
precisely what v2's "no session, authenticate every request" model demands.
Nothing here depends on `Mcp-Session-Id`.

The MCP directory is ~9,200 lines, but only `McpHttpServer.ts` (258 lines) is
transport. `OrchestratorMcpService`, `WorktreeMcpService`, and
`PreviewAutomationBroker` are business logic and stay as they are. The work is
the transport plus re-declaring toolkits in the SDK's tool format.

The thread-bound credential is also what makes email waits work: the server
already knows which thread an MCP call came from, so it knows which thread to
resume.

## What changes

### Removed

- `initialize` / `notifications/initialized` — no handshake
- `Mcp-Session-Id` header and the protocol-level session
- `logging/setLevel` — replaced by per-request
  `io.modelcontextprotocol/logLevel` in `_meta`
- `roots/list` and `notifications/roots/list_changed` — roots now fetched on
  demand via MRTR
- `resources/subscribe` / `resources/unsubscribe` — replaced by the
  `notifications` param of `subscriptions/listen`
- `ping`, in both directions
- The HTTP GET endpoint for server-to-client messages. All communication is
  POST.
- Resumable SSE streams via `Last-Event-ID`. A dropped connection now
  implicitly cancels the request; durability comes from tasks instead.

### Added

- **`server/discover`** — mandatory. Returns `supportedVersions`,
  `capabilities`, and `instructions`.
- **Per-request `_meta`** — every request carries
  `io.modelcontextprotocol/protocolVersion` (required, must match the
  `MCP-Protocol-Version` header or the server returns 400),
  `io.modelcontextprotocol/clientInfo`, and
  `io.modelcontextprotocol/clientCapabilities`. Servers **MUST NOT** infer
  capabilities from prior requests.
- **`Mcp-Method` and `Mcp-Name` headers** — lets gateways route and authorize
  without parsing JSON bodies.
- **`subscriptions/listen`** — a POST whose response is a long-lived SSE stream
  carrying notifications only. Clients opt in per notification type; the server
  **MUST NOT** send types not requested. First message on the stream is
  `notifications/subscriptions/acknowledged`.
- **MRTR (Multi Round-Trip Requests)** — a server needing input returns
  `resultType: "input_required"` in an `IncompleteResult`; the client retries
  with `inputResponses` attached. Replaces held-open bidirectional streams for
  elicitation, sampling, and listRoots.
- **Tasks extension** (`io.modelcontextprotocol/tasks`) — see below.
- **Response caching** — `ttlMs` and `cacheScope` on tools, prompts, resources,
  and resource-read list responses. Opportunity, not a requirement.

### New error codes

- `-32022` `UNSUPPORTED_PROTOCOL_VERSION` — carries `supported` and `requested`
- `-32021` `MISSING_REQUIRED_CLIENT_CAPABILITY` — carries
  `requiredCapabilities`

Both return HTTP 400.

### Auth hardening

- RFC 9207 issuer validation is mandatory
- Client credentials bound to their issuing authorization server
- `application_type` support for Dynamic Client Registration, fixing localhost
  redirects
- Client ID Metadata Documents (CIMD) supersede Dynamic Client Registration

### Deprecated with a 12-month offramp

Roots, Sampling, and Logging, plus the legacy HTTP+SSE transport. Don't build
anything new on them.

## Tasks extension

The durable-work primitive, and the reason this migration exists.

A server that decides a request is long-running returns a `CreateTaskResult`
(`resultType: "task"`) carrying `taskId`, initial status, `ttlMs`, and
`pollIntervalMs`. **The task must be durably created before the response is
sent.** The client then polls `tasks/get`, or receives pushes.

Lifecycle: `working` → `input_required` → `completed` | `failed` | `cancelled`.
The last three are terminal.

- `tasks/get` — current state; `result` on completed, `error` on failed
- `tasks/update` — client submits `inputResponses` against outstanding
  `inputRequests`
- `tasks/cancel` — cooperative; the server acknowledges but may not stop

**`notifications/tasks`** is the part that matters for email. Servers can push
status updates carrying the full task state, delivered over
`subscriptions/listen`. Per the spec: polling is the default, but if a server
supports notifications, clients can rely on them instead. That is the no-polling
path.

Both sides must opt in: the client declares
`io.modelcontextprotocol/tasks` in per-request `extensions`, the server
advertises it in `server/discover`. A server **must** verify the client declared
support before returning a task.

**Caveat:** the official extension client-support matrix doesn't track tasks at
all — it lists only MCP Apps, OAuth Client Credentials, and Enterprise Auth. Core
v2 support and tasks support are separate things, and a client can have the
first without the second. Everything built on tasks needs a non-tasks fallback.

## Verification

`OrchestratorMcpToolkit.integration.test.ts` (2,621 lines) is the conformance
gate. It must pass against the v2 transport before any email work lands.

Beyond that:

- `server/discover` returns correct `supportedVersions` and capabilities
- A request with a mismatched `MCP-Protocol-Version` header vs `_meta` returns
  400
- A request missing required `_meta` fields is rejected with `INVALID_PARAMS`
- An unsupported version returns `-32022` with the `supported` list populated
- A task returned to a client that did not declare the capability is a bug —
  test it
- `subscriptions/listen` sends the acknowledgment notification first, and sends
  nothing the client didn't opt into
- Connect each provider and record which negotiate `2026-07-28`

## Docs

- `docs/internals/` — the transport migration and the tasks/subscriptions model
- `docs/operations/` — what breaks for which provider, and how to tell
- `docs/internals/glossary.md` — MRTR, tasks, `subscriptions/listen`
