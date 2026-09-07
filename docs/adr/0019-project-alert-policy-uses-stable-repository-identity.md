# Project alert policy uses stable repository identity

The Project Settings UI edits one project-level Alert Policy, but visual project grouping is a local
preference and cannot identify synced policy. Repository-backed projects therefore key alert policy
by stable repository identity. The policy continues to cover matching worktrees and environments
when another device groups them differently. Non-repository projects use their environment-scoped
project identity. Thread overrides remain narrower than either project identity.
