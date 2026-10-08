# Cross-environment thread access

`pathway_thread_read` and `pathway_thread_send` resolve a thread ID in two steps. `pathway_thread_wait`, `pathway_thread_interrupt`, and `pathway_thread_list` keep their project or company scope.

1. **This environment.** Any non-deleted thread, whatever its project or company (`findLocalThread` in `apps/server/src/mcp/OrchestratorMcpService.ts`). Invocations with an `orchestratorOrigin` (AI contact assignments) keep the old project or company scope, because other company members can direct them.
2. **The account's other environments.** On a local miss, `RemoteThreads` (`apps/server/src/cloud/remoteThreads.ts`) calls the Cyndrbase action `connectGrants:issueThreadAccess` with the environment's own service token and `access: "read" | "send"`.

`issueThreadAccess` authorizes and routes the request:

- The caller must be an environment identity whose `cnf.jkt` matches one of its active registrations. That only authenticates the caller. "The account" is the single user with an unrevoked `relayEnvironmentLinks` row for the environment. It is never taken from `registeredByMembershipId`, because a manager may have created the registration.
- It looks up the thread in `agentThreads.by_thread`. It picks the most recently updated row on another environment, in an active company where the account has an active membership holding the access's permission, and whose target registration is active. Reads need `AuthPeerReadGrantPermission` (`environments.read`). Sends need `AuthPeerSendGrantPermission` (`remoteAgents.control`), the same permission the environment-command path requires for `sendMessage`.
- It records a single-use connect grant for that membership. It returns the token and the target environment ID.

The server then connects with `PeerEnvironments.connect` over the relay. The target authorizes the grant against its own replica, as it does for any peer connect.

- **Read grants** get read-only scopes (`orchestration:read`, `relay:read`), and the caller requests only those. The server fetches the thread and only the fork sources that the requested page shows.
- **Send grants** get `AuthPeerSendScopes` (orchestration read and operate only). The server loads the target projection. `planRemoteSend` treats a deleted thread as not found. If the message ID is already on the thread (an earlier attempt landed but its reply was lost), the retry reports that outcome without dispatching again. Otherwise the server applies the caller's runtime and interaction mode ceiling, derives the dispatch mode with `sendDispatchMode`, dispatches `message.dispatch`, and reads the result with `sendOutcome`. These are the same helpers `ThreadManagementService.sendToThread` uses locally. The target's `dispatchCommand` handler attributes commands from peer environment sessions to `agent` (`dispatchActor` in `apps/server/src/ws.ts`), so remote MCP messages keep agent provenance.

Transcripts and messages move between environments and never enter Cyndrbase.

## Starting threads elsewhere

`delegate_task` with `targetEnvironmentId` and `targetProjectId` starts a thread on another environment. Agents find both IDs with `pathway_environments_list`, backed by the Cyndrbase query `connectGrants:launchTargets`. Before dispatching, `OrchestratorMcpService` asks `RemoteThreads.launchGrant` for a grant. That calls `connectGrants:issueProjectLaunch(environmentId, localProjectId)`.

- The caller and account are resolved exactly as for thread access.
- It needs an active `environmentBindings` row for that environment and local project, on another environment, whose cloud project is neither archived nor deleted. The account needs an active membership in that company holding both `remoteAgents.dispatch` and `remoteAgents.control`.
- The grant is a send grant (`threadAccess: "send"`, `remoteAgents.control`), so it gets the same narrowed `AuthPeerSendScopes` session and every mixed-version layer below. `launchThread` needs only operate scope. Targets without `peerThreadGrants` are listed with `updateRequired: true` and refused at issue with `AuthPeerThreadAccessUnsupportedCode`.

`RemoteDispatch` then launches directly with that grant, passing the calling thread as `remoteParent`. The target creates an attached thread (see the glossary) whose lineage names that thread and `parentEnvironmentId`. Lineage in the web client joins shells across environments to show it on both sides. The launch uses the environment-command ID as its command ID, so a retry after a lost reply converges on the same thread. Agents can no longer supply `connectGrantToken` or `cloudProjectId`. The durable fallback still cannot issue commands from a server (`member-authorization-unavailable`), so a target that is offline fails instead of queueing.

## Mixed-version safety

A thread grant must never become a full peer session. Servers from before this change issue `AuthPeerEnvironmentScopes` (including terminal and review) for every peer grant, and a caller requesting fewer scopes does not stop another holder of the bootstrap credential from redeeming more. Every layer below fails closed, for read and send grants alike.

1. **Handshake.** For a peer environment presenting a thread grant, the relay signs the target's mint proof with a thread-access scope instead of `environment:connect` (`mintScope` in `infra/relay/src/environments/EnvironmentConnector.ts`). Pathway Cloud tags thread grants with `threadAccess`. Read grants use `RelayEnvironmentConnectReadScope` (`environment:connect-read`). Send grants use `RelayEnvironmentConnectSendScope` (`environment:connect-send`).
   - Older targets decode the proof's scope as the literal `environment:connect`, so they reject both and mint nothing, whatever their registration claims.
   - Current targets accept these scopes only on the peer path (`apps/server/src/cloud/http.ts`). They mint `AuthPeerReadScopes` (`orchestration:read`, `relay:read`) for reads and `AuthPeerSendScopes` (adding `orchestration:operate`) for sends, with no terminal, review, access, or Computer scopes. Untagged peer grants, such as caller-supplied remote-dispatch grants (status queries carry `environments.read`), keep the ordinary connect scope and ordinary peer scopes in both version directions.
2. **Redeem.** Grants carry `threadAccess`, which `connectGrants.validate` returns to the relay. `validate` refuses a thread grant, without consuming it, unless the redeeming relay asserts `signsThreadAccessMintScopes: true` (`infra/relay/src/auth/ConvexConnectGrants.ts`) and the target registration still advertises `capabilities.peerThreadGrants`. So an older or rolled-back relay can never carry one to a target as an ordinary connect. Human-issued grants and caller-supplied remote-dispatch grants have no `threadAccess` and redeem as before.
3. **Issue (for a clear error).** `recordThreadAccess` skips candidates whose registration lacks `capabilities.peerThreadGrants === true` (missing, `false`, and malformed values all count as unsupported). If only such targets publish the thread, it throws `AuthPeerThreadAccessUnsupportedCode`, and `RemoteThreads` turns that into an "update Pathway there" message. No grant row is written.

The caller requests the same narrow scopes (`RemoteThreads`), and direct remote status queries (`apps/server/src/cloud/remoteDispatch.ts`) request `AuthPeerReadScopes`, so both work with narrowed credentials.

| Relay              | Pathway Cloud                | Target server                       | Thread grant result                                                  |
| ------------------ | ---------------------------- | ----------------------------------- | -------------------------------------------------------------------- |
| new                | new                          | new                                 | read-only, or read-and-dispatch, session                             |
| new                | new                          | old, registration accurate          | refused at issue; update message                                     |
| new                | new                          | old, stale `peerThreadGrants: true` | the target rejects the thread-access mint proof; nothing minted      |
| old or rolled back | new                          | any                                 | refused at redeem (no `signsThreadAccessMintScopes`); nothing minted |
| any                | old (no `issueThreadAccess`) | any                                 | action missing; generic "could not reach"; nothing issued            |

A caller older than this change never requests thread grants. `connectGrants:issueThreadRead` existed only in unmerged commits of this change and never shipped, so no released reader calls it and no compatibility alias is kept.

### Deployment order

Safety does not depend on ordering, because each step fails closed. Ordering only decides when remote thread access starts working.

1. **Deploy the Cyndrbase backend (`packages/backend`).** Launch grants need `connectGrants:launchTargets` and `connectGrants:issueProjectLaunch`, which newer servers call; older backends answer with a generic failure. It adds `agentThreads.by_thread`, `connectGrants.threadAccess`, `connectGrants:issueThreadAccess`, the redeem checks, the optional `signsThreadAccessMintScopes` argument and `threadAccess` result, and the `peerThreadGrants` descriptor validator. Until the relay is updated, thread grants are issued but refused at redeem.
2. **Then deploy the relay (`infra/relay`).** It sends `signsThreadAccessMintScopes: true` (an older backend would reject that unknown argument and break every grant connect), and it signs thread-access mints.
3. **Then release servers (desktop, `npx`).** The registration validator is strict, so a server advertising `peerThreadGrants` cannot update its registration against an older backend. Remote thread access works once the target is updated and has re-registered; until then it fails closed with the update message.

## Limits

- Discovery depends on the published `agentThreads` shells, so threads in unbound local projects are invisible.
- The `peerThreadGrants` capability is self-reported and can go stale. Enforcement rests on the handshake scopes and the relay assertion; the capability adds a clearer error and a redeem-time check.
- A send session holds `orchestration:operate` for the whole target environment, not one thread, and the caller's runtime and interaction mode ceiling is checked by the caller, not bound into the grant. That matches the orchestration authority the account's `remoteAgents.control` permission already confers through remote dispatch. Binding a session to one thread or mode would need target-side per-session restrictions.
- Local sends still re-check steerability on a retry after a lost reply; only the remote path recognizes an already-landed message.
