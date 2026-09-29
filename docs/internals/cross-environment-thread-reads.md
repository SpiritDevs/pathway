# Cross-environment thread reads

`pathway_thread_read` resolves a thread ID in two steps.

1. **This environment.** Any non-deleted thread, whatever its project or company (`loadReadableThread` in `apps/server/src/mcp/OrchestratorMcpService.ts`). Invocations with an `orchestratorOrigin` (AI contact assignments) keep the old project/company scope, because other company members can direct them.
2. **The account's other environments.** On a local miss, `RemoteThreadReader` (`apps/server/src/cloud/remoteThreadRead.ts`) calls the Convex action `connectGrants:issueThreadRead` with the environment's own service token.

`issueThreadRead` authorizes and routes the request:

- The caller must be an environment identity whose `cnf.jkt` matches one of its active registrations. That only authenticates the caller. "The account" is the single user with an unrevoked `relayEnvironmentLinks` row for the environment. It is never taken from `registeredByMembershipId`, because a manager may have created the registration.
- It looks up the thread in `agentThreads.by_thread`. It picks the most recently updated row on another environment, in an active company where the account has an active membership with `environments.read`, and whose target registration is active.
- It records a single-use connect grant for that membership with permission `AuthPeerReadGrantPermission` (`environments.read`). It returns the token and the target environment ID.

The server then uses `PeerEnvironments.connect` with `AuthPeerReadScopes` to call `getThreadProjection` over the relay. It fetches the thread and only the fork sources that the requested page shows. The target authorizes the grant against its own replica, as it does for any peer connect. For a grant carrying `AuthPeerReadGrantPermission`, the target mints read-only scopes (`orchestration:read`, `relay:read`), so the session cannot write, run terminals, or drive the desktop. Transcripts move between environments and never enter Convex.

Limits:

- Discovery depends on the published `agentThreads` shells, so threads in unbound local projects are invisible.
- Only reads are cross-scope. Send, wait, interrupt, and list keep their project/company scope.
