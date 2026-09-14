# Following up with delegated workers

Open **Worker conversation** on a delegated assignment to send more instructions or answer its questions.

**After current turn** keeps a follow-up queued until the current work finishes. You can edit, remove, or move pending messages up. Once delivery is accepted, the message is frozen. **Steer running turn** requests an update to the current work; some providers apply this by interrupting and restarting their turn. Questions and steering are handled before follow-ups waiting for the current turn.

Workers can ask the coordinator for clarification. If it needs your answer, the question appears in the worker conversation. **Reply to worker** sends your answer back to the original question, including questions from supported subagents. Independent steering and stopping of provider-native subagents is not available here.

**Request stop** asks the environment to interrupt the assignment. A stop request is not confirmation that work stopped. An offline worker may still be running. Check the assignment's status before starting replacement work.

A delivered follow-up means Pathway saved its dispatch locally. The worker's result confirms completion. If delivery is uncertain, retry the same submission without creating another copy. These controls preserve the assignment's permissions and allowance limits; a message cannot renew a stopped assignment.
