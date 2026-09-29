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

A read grant must never reach a target that would turn it into a full peer session. Servers from before this change issue `AuthPeerEnvironmentScopes` for every peer grant, and a caller requesting fewer scopes does not stop another holder of the bootstrap credential from redeeming more. So read grants fail closed on the target's advertised `peerReadGrants` capability (`ExecutionEnvironmentCapabilities` in `packages/contracts/src/environment.ts`):

- **Issue.** `recordThreadAccess` skips read candidates whose registration descriptor lacks `capabilities.peerReadGrants === true`. A missing, `false`, or malformed value counts as unsupported. If only unsupported targets publish the thread, it throws `AuthPeerReadUnsupportedCode` (`environment-update-required`). `RemoteThreads` turns that into an "update Pathway there" message. No grant row is written.
- **Redeem.** Grants carry `threadAccess`. `connectGrants.validate` refuses a `threadAccess: "read"` grant, without consuming it, if the target registration no longer advertises the capability (for example, after a downgrade inside the grant's one-minute lifetime). Human-issued grants have no `threadAccess` and are unchanged.
- **Target.** Current servers advertise `peerReadGrants: true` and mint `AuthPeerReadScopes` for peer grants carrying `AuthPeerReadGrantPermission`.
- **Sends** already receive full peer scopes on every version, so they are not gated on the capability.

| Pathway Cloud                | Caller server | Target server          | Read result                                               |
| ---------------------------- | ------------- | ---------------------- | --------------------------------------------------------- |
| new                          | new           | new                    | read-only session                                         |
| new                          | new           | old (no capability)    | refused before a grant exists; update message             |
| new                          | new           | downgraded after issue | grant refused at redeem                                   |
| old (no `issueThreadAccess`) | new           | any                    | action missing; generic "could not reach"; nothing issued |
| any                          | old           | any                    | caller never requests thread grants                       |

### Deployment order

1. Deploy the Convex backend (`packages/backend`) first. It adds `agentThreads.by_thread`, `connectGrants.threadAccess`, `connectGrants:issueThreadAccess`, the redeem check, and the `peerReadGrants` descriptor validator.
2. Then release servers (desktop, `npx`). The registration validator is strict, so a server advertising `peerReadGrants` cannot update its registration against an older backend. This is the same ordering every new capability needs.
3. Remote reads work once the target server is updated and has re-registered its descriptor. Until then they fail closed with the update message.

## Limits

- Discovery depends on the published `agentThreads` shells, so threads in unbound local projects are invisible.
- The capability is self-reported by the target's key-bound registration, or by a manager with `environments.manage`. It is not a signed attestation.
- A send grant is an environment-wide peer credential, the same trust model as other peer connects. The target thread and the caller's mode ceiling are enforced by the caller, not bound into the grant.
- Local sends still re-check steerability on a retry after a lost reply; only the remote path recognizes an already-landed message.
