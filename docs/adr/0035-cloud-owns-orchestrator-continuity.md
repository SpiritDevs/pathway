---
status: accepted
---

# Cloud owns orchestrator continuity; environments execute

Orchestrators coordinate work across environments and must retain their identity, chats, and memory when the selected execution environment changes. Pathway Cloud therefore owns orchestrator chats and memory, while an eligible environment runs the model with automatic host handover. When no eligible environment is online, messages queue. Always-on reasoning requires an always-on environment; this decision does not add a Pathway-hosted model runtime.

This deliberately differs from ordinary agent threads, whose complete histories remain environment-owned. Cross-environment coordination requires authorized context retrieval rather than implicitly replicating every delegated thread into the cloud.

Unstarted assignments can move immediately. A running assignment must be known to have stopped and its changes recovered before transferring execution. Connectivity loss alone cannot prove that work stopped; handover must not authorize duplicate actions. The detailed ownership and recovery protocol remains to be designed.
