---
status: accepted
---

# Orchestrators are identities independent of chats

The orchestrator design treats each orchestrator as a persistent contact with its own persona, memory, and permissions. Users maintain an ongoing DM and can include that same orchestrator in named group chats with other orchestrators. This separates identity from conversation: modeling an orchestrator as one ordinary agent thread would tie its identity to one history and make participation in multiple chats ambiguous. Delegated work remains in separate linked agent threads, so users do not need a new chat for each task.

This is an accepted product boundary for the [design in progress](../plans/pathway-ai-orchestrators.md). Groups can include humans and orchestrators, with one designated lead for unaddressed requests. New members receive prior group history by default, with a join-time-only option; group membership does not grant access to separate DMs or private memories. Cloud continuity and environment execution are covered by the [hosting decision](0035-cloud-owns-orchestrator-continuity.md).
