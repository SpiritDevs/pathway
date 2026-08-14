# Pathway Connect Relay

> [!NOTE]
> Sign in to Pathway Connect from the app under Settings > Connections.

The relay is the hosted control plane for Pathway Connect. It helps clients discover and connect to
remote environments, manages the cloud-side records needed for those connections, and delivers
optional mobile notifications and Live Activities.

The relay is intentionally not in the hot path for normal Pathway traffic. After a client connects,
regular API and WebSocket traffic goes directly between that client and the selected environment.
See the [Pathway Connect architecture overview](../../docs/internals/t3-code-connect-auth-flow.html) for the larger system
design.

## Responsibilities

The relay currently owns:

- Linking Pathway environments to a cloud account.
- Provisioning and tracking managed environment endpoints.
- Issuing short-lived credentials used to connect clients to linked environments.
- Listing linked environments and registered mobile devices for an account.
- Registering mobile notification preferences and APNs tokens.
- Receiving published agent activity and delivering notifications or Live Activity updates.
- Persisting relay state in Convex and exposing relay-specific traces for diagnostics.

The environment server and relay have separate credentials and trust boundaries. Read
[Environment Authentication Profile](../../docs/internals/environment-auth.md) before changing token,
credential, or authorization behavior.

## Code Map

- [`alchemy.run.ts`](./alchemy.run.ts) defines the deployed Alchemy stack.
- [`src/worker.ts`](./src/worker.ts) wires Cloudflare bindings, runtime layers, queues, and HTTP APIs.
- [`src/http/Api.ts`](./src/http/Api.ts) contains the relay HTTP handlers and authentication
  boundaries.
- [`src/environments`](./src/environments) contains environment linking, credentials, endpoint
  provisioning, and connection flows.
- [`src/agentActivity`](./src/agentActivity) contains mobile device registration, activity state,
  APNs delivery, and queue processing.
- [`src/auth`](./src/auth) contains relay token and DPoP proof handling.
- [`../../packages/backend/convex/relayPersistence.ts`](../../packages/backend/convex/relayPersistence.ts)
  defines the authenticated Convex functions used for relay state.

Shared request and response schemas live in
[`packages/contracts/src/relay.ts`](../../packages/contracts/src/relay.ts). Shared client-side relay
calls live in
[`packages/client-runtime/src/relay/managedRelay.ts`](../../packages/client-runtime/src/relay/managedRelay.ts).

## Working Locally

Install dependencies from the repository root, then run relay-focused checks from this directory:

```sh
vp install
cd infra/relay
vp test run
vp run typecheck
```

To run a smaller test set while iterating:

```sh
vp test run src/environments/EnvironmentLinker.test.ts
```

Before considering a change complete, run the repository-wide checks from the root:

```sh
vp check
vp run typecheck
```

Backend changes should include tests. Prefer testing the real business logic with external
dependencies represented at their boundary rather than mocking internal behavior.

## Deployment

The relay deploys through Alchemy:

```sh
vp run --filter pathway-relay deploy
```

The stack provisions the Cloudflare Worker and queues, managed endpoint resources, and relay
tracing resources. Relay records live in the Convex deployment named by `CONVEX_URL`; use its
client URL ending in `.convex.cloud`, not its HTTP Actions URL. Copy
[`infra/relay/.env.example`](./.env.example) to
`infra/relay/.env` and fill in the deployment-specific values before deploying. Alchemy loads that
file from the relay directory. Runtime secrets include Clerk credentials and, when enabled, APNs
credentials. Set `APNS_ENABLED=false` to run the relay without mobile push notifications or Live
Activities; web, desktop, Convex sync, and remote agent control remain available. Production adopts
the configured API and tunnel DNS zones as retained Cloudflare resources. Personal stages reference
the production-owned zones.

The `prod` Alchemy stage is the shared hosted relay for stable and nightly clients and owns the
retained Cloudflare zones. Deploy it before a personal stage, which references those zone resources.
Each stage can still use the Convex deployment named by its own `CONVEX_URL`:

```sh
vp run --filter pathway-relay deploy --stage prod
vp run --filter pathway-relay deploy --env-file .env.local
```

Alchemy defaults personal deployments to the `dev_$USER` stage. Relay custom domains apply the same
DNS-safe sanitization as Alchemy physical resource names, so `prod` uses
`relay.<RELAY_API_ZONE_NAME>` and `dev_julius` uses
`relay-dev-julius.<RELAY_API_ZONE_NAME>`. Managed environment endpoints are provisioned below
`RELAY_TUNNEL_ZONE_NAME`, which may be a different Cloudflare zone. Production tunnel hostnames use
`prod-<digest>.<RELAY_TUNNEL_ZONE_NAME>`; personal stages use
`<stage>-<digest>.<RELAY_TUNNEL_ZONE_NAME>`. `RELAY_DOMAIN` remains available as an explicit API
domain override.

For the Pathway deployment, both Cloudflare zones are `spiritdevs.com`. That yields
`https://relay.spiritdevs.com` for `prod` and, for example,
`https://relay-dev-corey.spiritdevs.com` for `dev_corey`.

### First deployment bootstrap

A new Convex deployment cannot trust the relay until the relay publishes its key. Bootstrap the
pair in this order:

1. Create the Convex deployment, set `CLERK_JWT_ISSUER_DOMAIN`, and record its client URL.
2. Deploy the relay with `CONVEX_URL` set to that deployment. The JWKS route has no persistence
   dependency, so `https://<relay-origin>/.well-known/jwks.json` is available before the normal
   relay APIs are healthy. Verify that it returns the public P-256 key.
3. In Convex, set `PATHWAY_RELAY_JWT_ISSUER=https://<relay-origin>` and
   `PATHWAY_RELAY_JWKS_URL=https://<relay-origin>/.well-known/jwks.json`, then run
   `pnpm --filter @t3tools/backend exec convex dev --once`.

Convex statically requires every environment variable referenced by `auth.config.ts`, so both relay
variables must be present before codegen or deployment. Relay service calls then use short-lived
ES256 JWTs; the Worker never receives a Convex deploy key.

After a successful deploy, the wrapper updates the repository-root `.env` file with the derived relay
URL. That makes subsequent source builds point at the relay that was just deployed without copying
the URL manually.

### Deployment CI

The relay is versioned separately from client releases. `.github/workflows/deploy-relay.yml` deploys
the shared Alchemy `prod` stage on every push to `main`. Stable and nightly release builds both
resolve their static public config from the same
`production` GitHub environment. Pull requests do not deploy relay stages. Developers can
deploy personal non-production stages locally with any stage name other than `prod`.

The repository must define these Actions variables shared by relay deployments:

- `CLOUDFLARE_ACCOUNT_ID`
- `AXIOM_ORG_ID`

The repository must define these Actions secrets shared by relay deployments:

- `CLOUDFLARE_API_TOKEN`
- `AXIOM_TOKEN`

The `production` GitHub environment must define these Actions variables:

- `RELAY_API_ZONE_NAME`
- `RELAY_TUNNEL_ZONE_NAME`
- `RELAY_DOMAIN` if overriding the derived production relay domain
- `CONVEX_URL`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_AUDIENCE`
- `CLERK_JWT_TEMPLATE`
- `APNS_ENABLED` (`false` disables mobile push notifications and Live Activities)

When `APNS_ENABLED=true`, the environment must also define:

- `APNS_ENVIRONMENT`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_BUNDLE_ID`

The `production` GitHub environment must define this Actions secret:

- `CLERK_SECRET_KEY`

When `APNS_ENABLED=true`, it must also define:

- `APNS_PRIVATE_KEY`

The account-scoped repository credentials are consumed by Alchemy while provisioning relay stages;
they are not bound into the relay Worker. The relay uses short-lived ES256 service JWTs rather than
a Convex deploy key. The production deployment uses an Axiom personal access token,
so `AXIOM_ORG_ID` must accompany `AXIOM_TOKEN`. The release workflow reads the production relay's
derived public URL and Clerk publishable key from the same environment for downstream desktop, CLI,
and hosted web builds.

See:

- [Pathway Connect Clerk Setup](../../docs/internals/t3-connect.md) for Clerk keys, JWT templates, and sign-up restrictions
  setup.
- [Relay Observability](../../docs/operations/relay-observability.md) for deployment tracing and diagnostics.
- [Pathway Connect Architecture Overview](../../docs/internals/t3-code-connect-auth-flow.html) for the full link,
  connect, endpoint, and notification flows.
