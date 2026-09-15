# Agent conversations on iOS

Open an agent thread to read its conversation and continue working on its connected environment. The conversation has its own screen; Back returns to the thread list or parent conversation.

A status below the latest message shows when your message is sending, queued, preparing a workspace, starting the agent, working, or waiting. It clears when the run finishes or stops. If the connection drops, the app hides the activity status until it has the latest thread state again.

When you scroll away from the latest message, a floating button above the composer returns you to it. While the agent works, it shows an orb and the current activity. When work stops, it returns to a down chevron. Tapping it resumes following new replies.

Completed turns keep the final answer visible and fold intermediate work into a **Worked for…** row. Expand it to read progress updates, then expand individual search, command, tool, and file rows for details. Questions, approval requests, plans, and subagent links remain accessible in the conversation.

The file count above the composer opens the changed files and available diffs. Copy an answer with its copy button, or hold a message to open its actions. Fork from an answer to continue from that turn in a separate conversation. The thread menu can also fork the latest state and copy the conversation.

Hold the latest message you sent and choose **Edit and restart** when the provider supports restoring that conversation point. Editing preserves attached context. Messages that have already changed workspace files may no longer be editable.

Queued messages, including messages saved to Pathway Cloud, appear in a small count bubble above the composer. They enter the conversation when the environment starts them. Tap it to open a compact list, drag a row's reorder handle to change its position, or use the row's Edit, Steer, and Delete buttons. For a message still waiting in Cloud, Edit opens an editor and Save updates it in place, keeping its attachments. For a message already queued on the environment, Edit restores it to the composer; send or stash your current draft first. Steer sends a follow-up to the active turn, and Delete removes it from the queue. The first message that creates a thread stays first. Messages being sent cannot be changed until the environment confirms their state. Agent-generated replies cannot be edited or steered.

The queue and question sheets close automatically when their last item is removed or resolved. The changed-files sheet also closes if its list becomes empty.

On iPhone and narrow iPad windows, the bottom row has compact navigation on the left, the message composer in the middle, and the orchestrator button on the right. Tap the middle composer to expand it for writing; tapping the conversation returns to the compact row and keeps your draft. Expanding navigation temporarily hides the middle composer until you collapse navigation again. Wider iPad windows keep the editor alongside sidebar navigation.

Tap the floating composer to write. Tap the conversation or the controls above the composer to unfocus the message field and dismiss the keyboard. Your draft stays in place; tap the field to continue writing. Add photos, images from the clipboard, or files using the attachment menu. Upload failures leave the attachment available to retry or remove. Tap the model name in either the new-thread composer or an existing conversation to open Thread settings. Expand a provider to choose a model, or use Find a model at the bottom. Options show the selected model's supported controls, including reasoning effort and speed or service tier when available, plus runtime access and planning mode. Save applies your selections; Cancel discards them.

While the agent works, stop the response or queue another message. Hold Send to choose whether to queue the message or steer the current turn. Sending and property changes report failures without discarding the draft. The same Send menu can start a new thread or a side chat when the provider supports it.

The round send button stays visible in both the collapsed and expanded composer. While the agent is preparing or working, it shows a spinner. With an empty draft, tap it to stop the response. With text or attachments in the composer, the spinner changes to the selected Steer or Queue icon. Tap it to send your follow-up; a separate Stop button remains available. The working spinner returns when the composer is empty. Reduce Motion replaces the spinner with a still icon.

Use `@` to find a workspace file, `$` for a provider skill, and `/` for supported commands. `/model` searches the available models. Suggestions replace the token at your cursor and preserve the rest of the draft.

The attachment menu also contains **Stash draft** and **Saved prompts**. Saved prompts keep text and attachment bytes on this device, so they can be restored into another thread without changing its model. Restoring appends to an existing draft.

The agents pill beside the file summary opens a compact live list. Working agents appear first, and each row shows whether the agent is working, finished, waiting, stopped, or failed. Tap a row to open its conversation.

Subagent rows open the child conversation as a full screen. You can inspect its work and send a follow-up, then return to the parent. A subagent managed by its provider inherits configuration from its parent; its model controls explain that restriction.

Questions show the available options and a field for your own answer. For several questions, move through them before sending the complete response. Approval requests offer the available approval decisions. A disconnected or historical request cannot submit a new response.

The model picker shows favourites first, groups models by provider, and marks the selected model and each provider's default. Use **Settings → Favourite models** to add or remove favourites; the star beside model search opens the same screen. Mobile favourites are saved on this device separately for each environment. Providers reported by the environment remain visible when they are not installed, disabled, or require sign-in; their models cannot be selected until setup is complete.

The thread menu at the top includes Rename, Pin or Unpin, Settle or Reopen, Force settle, Snooze or Wake, and Regenerate title when the connected environment supports them. Copy the workspace path, branch, thread ID, or conversation from the same menu. Archive and Delete ask for confirmation; archived threads can be restored.

Thread rows show compact status labels so you can scan for Working, Preparing, Queued, Waiting, Question, Approval, Review plan, Failed, Stopped, or Ready. A pending question or approval takes priority over background work. Status labels use text as well as color and update with the environment's thread state.

The notification bell is hidden when there are no notifications. It appears when notifications arrive; read notifications remain accessible from the bell.

Tap the compose button at the top of a conversation to start a new thread. The new-thread sheet preselects the current project, environment, provider, model and reasoning options, access mode, chat or plan mode, and temporary setting. You can change the defaults before sending. Tap outside the message field to hide the keyboard without losing your new-thread draft. Tap the field to keep writing. The existing conversation and its draft stay intact.

The new-thread project picker displays each project's icon when available. Projects without an available icon use the folder symbol; conversations use the conversation symbol. Project icons share the thread list's cache.

HEIC and HEIF photos are converted before upload so other clients and image-capable agents receive JPEG files, or PNG when transparency is present. The conversion preserves orientation and limits the longest edge to 4,096 pixels. Photo selection, pasting, file attachments, and imported shares use the same conversion. Already-sent HEIC files are unchanged and need to be resent to use the compatible format.
