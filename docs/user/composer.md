# Writing messages

The web and desktop composer starts as a single-line input. Clicking it, opening a menu,
or scrolling the conversation keeps its size unchanged. Text grows the input as it wraps,
up to six lines, then scrolls inside it. Short windows use a smaller limit so the conversation
stays visible. Deleting text or sending a message shrinks the input to fit the remaining draft.

Use the paperclip beside Send to add attachments. Their previews appear above the input in a
separate scrollable area, so a long draft or several attachments cannot fill the conversation.
You can still preview and remove attachments, inspect upload status, and retry failed uploads.

Before sending a new thread, changing the project from either the header or the project name
above the composer moves your current message and attachments to that project. You can switch
back without losing your draft. Branch and checkout selections reset for the selected project.

Choose **New Thread** to start a separate message. Your unfinished message stays saved under
its original project in the sidebar, where you can return to it later. Changing the project in
the new composer only moves that new draft. After switching profiles, New Thread selects the
first project in your project ordering for the selected profile if the previous thread's project
is outside that profile.

Checkout and branch controls sit above the input. Model, reasoning, and permission controls stay below the input. Narrow windows put additional
controls in the options menu. These menus do not expand the composer. The same layout applies
to new threads and existing conversations, including phone-sized web windows.

Conversations without a project omit the Build/Plan toggle from the web and desktop
composer, including its compact options menu.

Notices above the checkout controls form a stack, with each card behind the first appearing
narrower. Hover over the notices or focus their controls to lift the stack and reveal more notices.

Approval requests, questions from an agent, and plan follow-ups keep their own controls. Native
mobile apps retain their existing composer layout.

When you send the first message with **New worktree** selected, a workspace preparation card
appears beside your message. It shows preparation, checkout progress, and the setup action as
they happen. Once the workspace is ready for the agent, the card disappears and the Working
timer starts. Setup failures stay visible so you can inspect them.

Type `$` to pick a skill. Claude skill suggestions come from the selected project or
worktree and provider account. They refresh when you open the menu. With Claude, Pathway translates the selected `$name` into
a direct skill invocation, including when it appears mid-message. Skills reserved
for direct user invocation remain available. Skills switched off in Claude's
settings or reserved for the agent are omitted from the composer menus.

Claude runs one skill directly per message. If you mention several, the last
one runs directly and earlier mentions become requests for Claude's Skill tool.
Earlier user-only skills cannot run through that tool, so send each in its own message.
Claude skill names come from their directory names, and a user skill takes precedence
over a project skill with the same name.

Provider slash commands appear only when `/` starts the whole message, where the
provider can expand them. Pathway's `/model`, `/plan`, and `/default` commands
remain available at the beginning of any line.

## Pending questions

The action palette lists pending questions for the current thread. Select a request to answer
it in the composer, even when the original question is earlier in the conversation. Requests
with several questions open together so you can answer each one before submitting.

Select the X beside a request to ignore it. Ignoring removes it from the pending list on all
connected clients without sending a follow-up message. If the agent is waiting for that answer,
it receives an empty response. The thread's Input marker clears when no pending input remains.
You can show, hide, and reorder Pending questions in the action palette settings.
