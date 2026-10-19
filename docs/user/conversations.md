# Conversations

Start a conversation when you want to talk with an agent without choosing a project. Select Conversation in the project picker, or use New conversation in the command palette.

Conversations appear alongside your other threads with a chat icon. Each has its own working folder, so the agent can create files and use tools. A conversation keeps its files when it settles. Deleting it removes its working folder.

Your conversations are personal and remain visible when you switch companies. They appear in All by default. Enable Conversations in a Focus to include them there. You can enable this in several Focuses.

## Attach a project

Use the project selector while the agent is idle to attach a project on the same environment. Your thread and history stay in place. The agent can use both the project's workspace and the original conversation folder.

## Temporary conversations

Select Temporary in the upper-right corner before sending the first message. Temporary works with both project threads and projectless conversations. Temporary project threads use their own worktree.

Settling a temporary conversation deletes it and cleans up its owned workspace. Temporary conversations do not settle from inactivity. They can settle when you choose Settle, when a linked PR is merged, or after you explicitly choose Settle after completion.

Automatic settlement keeps the conversation if a run fails, work is still pending, changes are uncommitted, or commits are unpushed. If you settle manually with unfinished Git work, choose Review changes, Cancel, or Discard and delete. Files outside Git in a conversation's working folder are deleted without another warning.

Choose Keep conversation before it settles to retain it permanently. This preserves its files and history. You cannot make that existing conversation temporary again.

## Share a conversation

Share a personal conversation with people in companies you belong to. Choose Can view or Can collaborate for each recipient. Sharing a conversation does not share every conversation on its environment.
