# Context compaction

## Continue in a new chat

Use **Continue in a new chat** below a completed response to start a separate thread. The new chat shows the conversation through that response, including messages, files, and attachments. New messages belong to the new chat; the original conversation stays intact.

Choose **Continue in this workspace** to use the current files, or **Create new worktree** to use a separate checkout from the source workspace's latest commit. Uncommitted changes stay in the original workspace.

You can start typing immediately. Before your first message reaches the AI, Pathway prepares the earlier context for a fresh session, even when you keep the same provider and model. Long conversations are summarized first; short conversations use a bounded amount of history. The full conversation remains visible, and the AI can retrieve earlier messages when it needs more detail.

## Changing models

Pathway starts a fresh provider session when you send a message after changing the provider or model in an existing thread. The thread, files, checkpoints, and full timeline stay intact.

For shorter conversations, Pathway sends the relevant history directly to the new session. For longer conversations, it creates a compact summary first. The summary appears in the timeline and can be expanded or copied. If the selected compaction model is unavailable, Pathway uses a deterministic fallback and continues the switch without sending the full transcript.

Changing options such as reasoning effort, thinking mode, or speed does not compact context.

You can choose the model used for long summaries in **Settings → General → Context compaction model**. The default is Codex `gpt-5.6-sol` with medium reasoning effort.

## Claude native compaction

Claude can compact its current native session without changing models. Use `/compact` or the **Compact context** action in the context-window meter. Older Claude sessions with at least 100,000 tokens offer compaction before they resume.

The **Auto-compact after** Claude provider setting accepts a value from 100,000 to 1,000,000 tokens. Leave it blank to use Claude's default.
