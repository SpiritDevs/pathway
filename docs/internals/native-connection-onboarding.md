# Native server connection onboarding

The iOS, iPadOS and visionOS client can pair an existing server, link it to the signed-in Pathway Connect account, register it with a chosen workspace, and attach explicitly selected local projects. Source credentials are separate from Clerk identity; pairing does not itself make projects appear in cloud discovery.

## Authority and setup sequence

`PathwayConnectionOnboardingModel` uses injected Clerk-authenticated relay account requests and Convex requests. `PathwayDirectConnections` owns only explicit direct connection preferences and source session credentials. Environment records, workspace memberships, registrations, project bindings and published thread shells remain server/Convex-owned.

1. Parse a normal pairing URL, a hosted `/pair?host=...#token=...` link, or a manual HTTP(S) address and token. Remove query/fragment credentials from the retained origin.
2. Read `/.well-known/pathway/environment`, require the Pathway application descriptor, and exchange the one-time token at `/oauth/token` using the installation DPoP key. Omit `scope` to inherit the actual pairing grant; account linking requires `relay:write` from an administrator pairing link.
3. Store the source session and direct preference in Keychain under the authenticated Clerk issuer plus subject. The token is never placed in preferences or a synthetic environment catalog. Source HTTP redirects are rejected. Expired sessions need a new pairing link because this source protocol has no refresh token.
4. Read actual `/api/connect/link-state` and `/api/orchestration/shell` for setup status and project choices. Nothing is selected for workspace adoption by default.
5. For a new managed link, check `cloud.getRelayClientStatus` and, if needed, consume `cloud.installRelayClient` until its completion receipt. Create the account challenge, obtain the source-signed link proof, create the relay account link and apply the returned source relay configuration. Direct mode uses the existing manual/publish-only contract without installing a tunnel. Existing source links are preserved; changing their mode requires explicit unlink.
6. Read `/api/connect/registration-info`, register the actual descriptor and proof key with `environments:register`, preserving active role/team assignments or selecting the least-privileged qualifying environment service role. Each chosen local project is attached with `cloudProjects:ensureEnvironmentProject`. Matching repository identities join the workspace's existing project. Partial writes are safe to retry; completed project bindings remain authoritative.
7. Successful managed setup selects Pathway Connect for future app connections. The paired source session stays available for server administration; users may explicitly prefer direct access again. Direct mode retains the saved override. Cloud discovery and server publishing determine when threads become available; setup does not invent thread or project records.

Account removal uses `DELETE /v1/client/environment-links/:id` and verifies authoritative account listing if tunnel teardown reports an uncertain failure. Explicit server unlink first calls `/api/connect/unlink`, then removes the account link. Removing a saved source session affects this device only.

## Remote source authorization

Previously `/api/connect/link-proof` and managed relay configuration accepted only requests whose hostname was loopback, preventing native LAN onboarding even after administrator pairing. The source now permits verified DPoP sessions with `relay:write` to configure **its own configured listener port at 127.0.0.1**. The native client obtains that port from link-state.

Remote DPoP calls cannot choose a local service through the request Host, public port or proof payload. Forwarded authority headers are rejected. Unbound bearer/cookie remote sessions and ordinary read-only pairing sessions cannot use this path. Existing direct loopback desktop browser flows remain supported. The trusted port is injected at the HTTP handler construction boundary; CLI reconciliation keeps its existing dependency shape.

## Integration

- `PathwayConnectionOnboardingView(model:accountKey:companies:roles:registrations:)`, with role and registration payloads keyed by company ID.
- `PathwayConnectionOnboardingModel(relayURL:relayRequest:cloudRequest:direct:)`; call synchronous `clear()` when signing out/changing accounts.
- `PathwayDirectConnections.shared.prepare(environmentID:accountKey:)` returns an optional prepared connection. ConnectClient uses it only for a saved enabled override; authentication, expiry and network failures are shown instead of silently falling back. The socket uses the actual `wsTicket` contract.
- Root shell owns the entry point, account identity, ConnectClient preference integration and platform local-networking configuration.

## Verification and boundaries

Eight native focused tests cover pairing URL handling, least-privilege registration, actual link/registration/binding call order, conflict rollback, incompatible account links, non-admin pairing, uncertain unlink and a late private response after account clearing. They run in an isolated SwiftPM harness using the checked-in source models with injected source/relay responses. Native connection views and source models typecheck for iOS and visionOS SDKs; this is not device or network execution evidence.

Focused server tests exercise remote admin authorization, configured-port selection despite spoofed Host/port, rejected supplied origins and forwarded authorities, missing listener configuration and legacy desktop browser behavior. Deploy the server changes together with the native release for remote account linking. Pairing an older server can still succeed, while its old loopback-only link endpoint rejects remote setup.

No Bonjour discovery or camera QR scanner is implemented; users paste a pairing link or enter a reachable address. External relay/tunnel provisioning, LAN permission prompts, Keychain persistence and server-to-Convex thread publication still need an integrated run on real configured infrastructure. No services, browsers, simulators or deployments were launched for these focused checks.
