# Cross-environment thread reads

`pathway_thread_read` resolves a thread ID in two steps.

1. **This environment.** Any non-deleted thread, whatever its project or company (`loadReadableThread` in `apps/server/src/mcp/OrchestratorMcpService.ts`). Invocations with an `orchestratorOrigin` (AI contact assignments) keep the old project/company scope, because other company members can direct them.
2. **The account's other environments.** On a local miss, `RemoteThreadReader` (`apps/server/src/cloud/remoteThreadRead.ts`) calls the Convex action `connectGrants:issueThreadRead` with the environment's own service token.

`issueThreadRead` authorizes and routes the request:

- The caller must be an environment identity whose `cnf.jkt` matches its active registrations. Those registrations must resolve, through `registeredByMembershipId`, to exactly one user. That user is "the account".
- It looks up the thread in `agentThreads.by_thread`. It picks the most recently updated row on another environment, in an active company where the account has an active membership with `environments.read`, and whose target registration is active.
- It records a normal single-use connect grant for that membership and returns the token and target environment ID.

The server then uses `PeerEnvironments.connect` to call `getThreadProjection` over the relay for the thread and for any fork sources in its timeline. The target authorizes the grant against its own replica, as it does for any peer connect. Transcripts move between environments and never enter Convex.

Limits:

- Discovery depends on the published `agentThreads` shells, so threads in unbound local projects are invisible.
- Only reads are cross-scope. Send, wait, interrupt, and list keep their project/company scope.
