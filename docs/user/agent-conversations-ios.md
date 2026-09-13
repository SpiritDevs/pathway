# Agent conversations on iOS

Open an agent thread to read its conversation and continue working on its connected environment. The conversation has its own screen; Back returns to the thread list or parent conversation.

Completed turns keep the final answer visible and fold intermediate work into a **Worked for…** row. Expand it to read progress updates, then expand individual search, command, tool, and file rows for details. Questions, approval requests, plans, and subagent links remain accessible in the conversation.

The file count above the composer opens the changed files and available diffs. Copy an answer with its copy button, or hold a message to open its actions. Fork from an answer to continue from that turn in a separate conversation. The thread menu can also fork the latest state and copy the conversation.

Hold the latest message you sent and choose **Edit and restart** when the provider supports restoring that conversation point. Editing preserves attached context. Messages that have already changed workspace files may no longer be editable. Queued messages have their own edit and queue actions.

Tap the floating composer to write. Tap the conversation or the controls above the composer to unfocus the message field and dismiss the keyboard. Your draft stays in place; tap the field to continue writing. Add photos, images from the clipboard, or files using the attachment menu. Upload failures leave the attachment available to retry or remove. The model menu lists the models available on the connected environment. Conversation options include the provider's supported settings, reasoning effort, access mode, and planning mode.

While the agent works, stop the response or queue another message. Hold Send to choose whether to queue the message or steer the current turn. Sending and property changes report failures without discarding the draft. The same Send menu can start a new thread or a side chat when the provider supports it.

Use `@` to find a workspace file, `$` for a provider skill, and `/` for supported commands. `/model` searches the available models. Suggestions replace the token at your cursor and preserve the rest of the draft.

The attachment menu also contains **Stash draft** and **Saved prompts**. Saved prompts keep text and attachment bytes on this device, so they can be restored into another thread without changing its model. Restoring appends to an existing draft.

The agents pill beside the file summary opens a compact live list. Working agents appear first, and each row shows whether the agent is working, finished, waiting, stopped, or failed. Tap a row to open its conversation.

Subagent rows open the child conversation as a full screen. You can inspect its work and send a follow-up, then return to the parent. A subagent managed by its provider inherits configuration from its parent; its model controls explain that restriction.

Questions show the available options and a field for your own answer. For several questions, move through them before sending the complete response. Approval requests offer the available approval decisions. A disconnected or historical request cannot submit a new response.

The model picker shows Favourites first, followed by provider submenus. Every favourite has a star. Use **Settings → Favourite models** to add or remove models; the same screen is available from composer options. Mobile favourites are saved on this device separately for each environment. Providers reported by the environment remain visible when they are not installed, disabled, or require sign-in; their models cannot be selected until setup is complete.
