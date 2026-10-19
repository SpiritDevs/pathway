---
status: accepted
---

# Orchestrator direction authority is distinct from action privileges

Orchestrators act autonomously within assigned roles and privileges, configured similarly to a user. Permission settings separately specify who can direct an orchestrator and what actions it can perform. An authorized director can assign work within that role even when the director's own action permissions differ; other chat participants can provide information without receiving direction authority. This is an explicit grant of authority through the orchestrator, rather than an intersection with every requesting participant's personal action permissions.

Delegated work preserves the originating assignment's limits. Group membership, another orchestrator's broader privileges, and context sharing do not implicitly expand those limits. Enforcement must apply to actual actions, not only to model instructions.

Management is a separate permission: owners manage personal orchestrators and designated managers manage shared ones. Permission changes apply to subsequent actions and delegated work. Orchestrators can propose changes but cannot grant themselves authority.

A cross-project invitation authorized for the participating projects grants relevant context access for the collaboration. Each project orchestrator retains its own dispatch responsibility; another project's coordinator requests work through it rather than acquiring its dispatch privileges. Provider-specific enforcement remains implementation work.
