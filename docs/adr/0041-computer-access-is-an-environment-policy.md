# Computer access is a per-environment policy

Each environment has a Computer access policy that decides which paired clients may start Computer tasks and turn on Computer control:

- **Any operator**: any client with `orchestration:operate`.
- **Scoped** (default): clients holding a new `computer:operate` scope. The scope is in the standard set and can be revoked per client in Settings → Connections.
- **Admins only**: only clients with administrative scopes.

Under every policy, any client that can read the thread (`orchestration:read`) can watch the preview, and any client that can operate it can answer approvals and press Stop. Only an admin client (`access:write`) can change the policy, because the policy grants access to the host's desktop.

Synara has no pairing model. Pathway needs this because a paired phone or remote browser would otherwise gain the host's logged-in desktop session implicitly. Agent autonomy (how much approval a task needs) is a separate axis from this policy.
