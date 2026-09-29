# Cross-environment thread access

`pathway_thread_read` and `pathway_thread_send` resolve a thread ID in two steps. `pathway_thread_wait`, `pathway_thread_interrupt`, and `pathway_thread_list` keep their project or company scope.

1. **This environment.** Any non-deleted thread, whatever its project or company (`findLocalThread` in `apps/server/src/mcp/OrchestratorMcpService.ts`). Invocations with an `orchestratorOrigin` (AI contact assignments) keep the old project or company scope, because other company members can direct them.
2. **The account's other environments.** On a local miss, `RemoteThreads` (`apps/server/src/cloud/remoteThreads.ts`) calls the Convex action `connectGrants:issueThreadAccess` with the environment's own service token and `access: "read" | "send"`.

`issueThreadAccess` authorizes and routes the request:

- The caller must be an environment identity whose `cnf.jkt` matches one of its active registrations. That only authenticates the caller. "The account" is the single user with an unrevoked `relayEnvironmentLinks` row for the environment. It is never taken from `registeredByMembershipId`, because a manager may have created the registration.
- It looks up the thread in `agentThreads.by_thread`. It picks the most recently updated row on another environment, in an active company where the account has an active membership holding the access's permission, and whose target registration is active. Reads need `AuthPeerReadGrantPermission` (`environments.read`). Sends need `AuthPeerSendGrantPermission` (`remoteAgents.control`), the same permission the environment-command path requires for `sendMessage`.
- It records a single-use connect grant for that membership. It returns the token and the target environment ID.

The server then connects with `PeerEnvironments.connect` over the relay. The target authorizes the grant against its own replica, as it does for any peer connect.

- **Read grants** get read-only scopes (`orchestration:read`, `relay:read`), and the caller requests only those. The server fetches the thread and only the fork sources that the requested page shows.
- **Send grants** get the ordinary peer scopes. The server loads the target projection. `planRemoteSend` treats a deleted thread as not found. If the message ID is already on the thread (an earlier attempt landed but its reply was lost), the retry reports that outcome without dispatching again. Otherwise the server applies the caller's runtime and interaction mode ceiling, derives the dispatch mode with `sendDispatchMode`, dispatches `message.dispatch`, and reads the result with `sendOutcome`. These are the same helpers `ThreadManagementService.sendToThread` uses locally. The target's `dispatchCommand` handler attributes commands from peer environment sessions to `agent` (`dispatchActor` in `apps/server/src/ws.ts`), so remote MCP messages keep agent provenance.

Transcripts and messages move between environments and never enter Convex.

## Mixed-version safety

A read grant must never become a full peer session. Servers from before this change issue `AuthPeerEnvironmentScopes` for every peer grant, and a caller requesting fewer scopes does not stop another holder of the bootstrap credential from redeeming more. Every layer below fails closed.

1. **Handshake.** For a peer environment presenting a grant with `AuthPeerReadGrantPermission`, the relay signs the target's mint proof with `RelayEnvironmentConnectReadScope` (`environment:connect-read`) instead of `environment:connect` (`mintScope` in `infra/relay/src/environments/EnvironmentConnector.ts`). Older targets decode the proof's scope as the literal `environment:connect`, so they reject it and mint nothing, whatever their registration claims (including a stale `peerReadGrants: true` left by a downgrade). Current targets accept the read scope only on the peer path, and always mint `AuthPeerReadScopes` for it (`apps/server/src/cloud/http.ts`). They also mint read-only scopes for any peer grant carrying the read permission.
2. **Redeem.** Grants carry `threadAccess`. `connectGrants.validate` refuses a `threadAccess: "read"` grant, without consuming it, unless both of these hold: the redeeming relay asserts `signsReadMintScope: true` (`infra/relay/src/auth/ConvexConnectGrants.ts`), and the target registration still advertises `peerReadGrants`. So a relay that predates the read mint scope, including after a relay rollback, can never carry a read grant to a target as an ordinary connect. Human-issued and send grants redeem as before.
3. **Issue (for a clear error).** `recordThreadAccess` skips read candidates whose registration lacks `capabilities.peerReadGrants === true` (missing, `false`, and malformed values all count as unsupported). If only such targets publish the thread, it throws `AuthPeerReadUnsupportedCode`, and `RemoteThreads` turns that into an "update Pathway there" message. No grant row is written.

Sends already receive full peer scopes on every version, so these gates do not apply to them. Direct remote status queries (`apps/server/src/cloud/remoteDispatch.ts`) request `AuthPeerReadScopes`, so they work with read-only grants.

| Relay              | Pathway Cloud                | Target server                     | Read result                                                 |
| ------------------ | ---------------------------- | --------------------------------- | ----------------------------------------------------------- |
| new                | new                          | new                               | read-only session                                           |
| new                | new                          | old, registration accurate        | refused at issue; update message                            |
| new                | new                          | old, stale `peerReadGrants: true` | the target rejects the read mint proof; nothing minted      |
| old or rolled back | new                          | any                               | refused at redeem (no `signsReadMintScope`); nothing minted |
| any                | old (no `issueThreadAccess`) | any                               | action missing; generic "could not reach"; nothing issued   |

A caller older than this change never requests thread grants.

### Deployment order

Safety does not depend on ordering, because each step fails closed. Ordering only decides when remote reads start working.

1. **Deploy the Convex backend (`packages/backend`).** It adds `agentThreads.by_thread`, `connectGrants.threadAccess`, `connectGrants:issueThreadAccess`, the redeem checks, the optional `signsReadMintScope` argument, and the `peerReadGrants` descriptor validator. Until the relay is updated, read grants are issued but refused at redeem.
2. **Then deploy the relay (`infra/relay`).** It sends `signsReadMintScope: true` (an older backend would reject that unknown argument and break every grant connect), and it signs peer read mints with the read scope.
3. **Then release servers (desktop, `npx`).** The registration validator is strict, so a server advertising `peerReadGrants` cannot update its registration against an older backend. Remote reads work once the target is updated and has re-registered; until then they fail closed with the update message.

## Limits

- Discovery depends on the published `agentThreads` shells, so threads in unbound local projects are invisible.
- The `peerReadGrants` capability is self-reported and can go stale. Enforcement rests on the handshake scope and the relay assertion; the capability adds a clearer error and a redeem-time check.
- A send grant is an environment-wide peer credential, the same trust model as other peer connects. The target thread and the caller's mode ceiling are enforced by the caller, not bound into the grant.
- Local sends still re-check steerability on a retry after a lost reply; only the remote path recognizes an already-landed message.
