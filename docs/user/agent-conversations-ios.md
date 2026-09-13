# Agent conversations on iOS

Open an agent thread to read its conversation and continue working on its connected environment. The conversation has its own screen; Back returns to the thread list or parent conversation.

A status below the latest message shows when your message is sending, queued, preparing a workspace, starting the agent, working, or waiting. It clears when the run finishes or stops. If the connection drops, the app hides the activity status until it has the latest thread state again.

Completed turns keep the final answer visible and fold intermediate work into a **Worked for…** row. Expand it to read progress updates, then expand individual search, command, tool, and file rows for details. Questions, approval requests, plans, and subagent links remain accessible in the conversation.

The file count above the composer opens the changed files and available diffs. Copy an answer with its copy button, or hold a message to open its actions. Fork from an answer to continue from that turn in a separate conversation. The thread menu can also fork the latest state and copy the conversation.

Hold the latest message you sent and choose **Edit and restart** when the provider supports restoring that conversation point. Editing preserves attached context. Messages that have already changed workspace files may no longer be editable.

Queued messages appear in a count button beside the changed-file counter. Tap it to open a compact list, swipe left for Edit and Delete, or swipe right for Steer. Touch and hold an environment-queued row, then drag it up or down to change its position. Cloud-saved follow-ups can also be reordered before the environment accepts them, or sent as a steer when a run is active. Blocked messages offer Retry. A conversation’s first message stays ahead of its follow-ups. Edit removes the message from the queue, closes the list, and restores its text and attachments to the composer. Send or stash an existing draft first. Agent-generated replies cannot be edited or steered.

The queue and question sheets close automatically when their last item is removed or resolved. The changed-files sheet also closes if its list becomes empty.

Tap the floating composer to write. Add photos, images from the clipboard, or files using the attachment menu. Upload failures leave the attachment available to retry or remove. The model menu lists the models available on the connected environment. Conversation options include the provider's supported settings, reasoning effort, access mode, and planning mode.

While the agent works, stop the response or queue another message. Hold Send to choose whether to queue the message or steer the current turn. Sending and property changes report failures without discarding the draft. The same Send menu can start a new thread or a side chat when the provider supports it.

The round send button stays visible in both the collapsed and expanded composer. While the agent is preparing or working, it shows a spinner. With an empty draft, tap it to stop the response. With text or attachments in the composer, the spinner changes to the selected Steer or Queue icon. Tap it to send your follow-up; a separate Stop button remains available. The working spinner returns when the composer is empty. Reduce Motion replaces the spinner with a still icon.

Use `@` to find a workspace file, `$` for a provider skill, and `/` for supported commands. `/model` searches the available models. Suggestions replace the token at your cursor and preserve the rest of the draft.

The attachment menu also contains **Stash draft** and **Saved prompts**. Saved prompts keep text and attachment bytes on this device, so they can be restored into another thread without changing its model. Restoring appends to an existing draft.

The agents pill beside the file summary opens a compact live list. Working agents appear first, and each row shows whether the agent is working, finished, waiting, stopped, or failed. Tap a row to open its conversation.

Subagent rows open the child conversation as a full screen. You can inspect its work and send a follow-up, then return to the parent. A subagent managed by its provider inherits configuration from its parent; its model controls explain that restriction.

Questions show the available options and a field for your own answer. For several questions, move through them before sending the complete response. Approval requests offer the available approval decisions. A disconnected or historical request cannot submit a new response.

The model picker shows Favourites first, followed by provider submenus. Every favourite has a star. Use **Settings → Favourite models** to add or remove models; the same screen is available from composer options. Mobile favourites are saved on this device separately for each environment. Providers reported by the environment remain visible when they are not installed, disabled, or require sign-in; their models cannot be selected until setup is complete.

The thread menu at the top includes Rename, Pin or Unpin, Settle or Reopen, Force settle, Snooze or Wake, and Regenerate title when the connected environment supports them. Copy the workspace path, branch, thread ID, or conversation from the same menu. Archive and Delete ask for confirmation; archived threads can be restored.

Thread rows show compact status labels so you can scan for Working, Preparing, Queued, Waiting, Question, Approval, Review plan, Failed, Stopped, or Ready. A pending question or approval takes priority over background work. Status labels use text as well as color and update with the environment's thread state.

The notification bell is hidden when there are no notifications. It appears when notifications arrive; read notifications remain accessible from the bell.

Tap the compose button at the top of a conversation to start a new thread. The new-thread sheet preselects the current project, environment, provider, model and reasoning options, access mode, chat or plan mode, and temporary setting. You can change the defaults before sending. The existing conversation and its draft stay intact.

The new-thread project picker displays each project's icon when available. Projects without an available icon use the folder symbol; conversations use the conversation symbol. Project icons share the thread list's cache.

Photo attachments keep their original file in Assets. Pathway prepares a compatible image for other clients and image-capable agents while preserving the original for download. Photo selection, pasting, file attachments, and imported shares use the same durable upload flow. Older local files can be made available across devices from their preview; historical messages are not rewritten.

The queued-message bubble counts both messages waiting on an environment and messages saved to the cloud for delivery. It sits beside the diff counter in a centered row, or in the center on its own. Tap it to open the queue sheet. Both cloud-saved follow-ups and environment-queued messages offer Edit, Delete, drag ordering, and Steer when available.

On compact screens, the collapsed composer sits between the main-navigation button on the left and the orchestrator button on the right. Tap the navigation button to expand the tabs. Expanding the composer hides those side controls until the editor collapses again.
