# Environment-authenticated remote dispatch

The server's remote dispatcher can enqueue `environmentCommands.issue` using its existing relay-minted `pathway-convex` service token. It resolves a unique company from the target environment's replicated project binding and sends the command to that company's durable queue. Direct dispatch with a supplied Connect grant continues to use the existing peer connection path.

Convex resolves the source environment's registered key and service roles. `startThread` requires `remoteAgents.dispatch`; `sendMessage` and `interrupt` additionally require `remoteAgents.control`; `statusQuery` additionally requires `environments.read`. The registering member's role assignments are never used to authorize an environment command.

The command and change-feed actor identify the source environment. `issuedByMembershipId` retains the source registration's active, same-company registering member for attribution. Keeping this field non-null preserves the existing command and sync schemas for installed clients and target claimants.

Each issue request owns its HTTP client, retries expired authentication once with the same command id, and surfaces permanent permission failures. Target execution continues through the existing command claimant and its lease and idempotency checks. An accepted enqueue returns deferred delivery; it is not a successful thread-start receipt.

Rollout requires deploying the Convex `environmentCommands.issue` change and updating the source Pathway server. Existing target servers that run the command claimant can consume these commands without a schema migration. Updating only the mobile client cannot enable server-side remote dispatch.
