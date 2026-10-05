# Writing messages

The web and desktop composer starts as a single-line input. Clicking it, opening a menu,
or scrolling the conversation keeps its size unchanged. Text grows the input as it wraps,
up to six lines, then scrolls inside it. Short windows use a smaller limit so the conversation
stays visible. Deleting text or sending a message shrinks the input to fit the remaining draft.

Markdown formats as you type on web and desktop. Bold, italic, strikethrough, inline code,
headings, and fenced code blocks appear formatted, and their markers stay visible in a muted
color so you can still edit them. The agent receives exactly the markdown you typed. Very long
messages, such as large pastes, stay unformatted so typing remains fast.

Use the plus button on the left of the input to open the Add menu. It grows out of the top of
the message field and covers the environment controls while open. The Add section holds
attachments, Goal, Plan mode, Computer use (when the environment supports it), Sketch, and
Stash prompts. Your skills follow. Search to find an item. Stash prompts opens your stashed prompts:
stash the current draft, restore a prompt into this thread, or delete one. Until you have a
stashed prompt, the Add section shows Stash current prompt instead, and only when the input
has something to stash.

Each save adds a separate prompt, newest first, and clears its text and attachments from the
input. Restoring adds to your current draft and keeps the saved prompt for reuse. The stash
saves on this device and holds up to 20 prompts. Adding a 21st removes the oldest and shows
a notice. Select the X beside a saved prompt to delete it.

Choose Files and folders to upload files from your device or reference a file or folder
in the selected environment's project. Attachment previews appear above the input in a
separate scrollable area, so a long draft or several attachments cannot fill the conversation.
You can still preview and remove attachments, inspect upload status, and retry failed uploads.

Choose Sketch, or type `/sketch`, to draw a quick design on a blank page. Draw with the pen,
add text, rectangles, ellipses, arrows, and lines, and pick a color and stroke size. The eraser
removes whatever it touches. Use Select to move, recolor, or delete a single item, and double-click
text to edit it. Undo and redo cover every change. Choose the check button, or press
Command-Enter (Ctrl+Enter on Windows and Linux), to attach the sketch as an image. Until you send the message, select
the sketch's preview to reopen it and keep editing; saving replaces the attached image. Closing
with unsaved changes asks before discarding them. Sketches are available on web and desktop.

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

Choose Goal in the Add menu to change the footer's Build control to Goal. The input prompts
you to describe your goal and define measurable outcomes. Goal asks the agent to work toward
those outcomes and report progress in the message you send. The selection stays with your
draft, including after a reload. Choose Build to leave Goal, or choose Plan mode to plan first.

Conversations without a project omit the Build/Plan toggle unless Goal is selected.

Notices above the checkout controls form a stack, with each card behind the first appearing
narrower. Hover over the notices or focus their controls to lift the stack and reveal more notices.

Approval requests, questions from an agent, and plan follow-ups keep their own controls. Native
mobile apps retain their existing composer layout.

When you send the first message with **New worktree** selected, a workspace preparation card
appears beside your message. It shows preparation, checkout progress, and the setup action as
they happen. Once the workspace is ready for the agent, the card disappears and the Working
timer starts. Setup failures stay visible so you can inspect them.

Typing `/`, `$`, or `@` opens the same panel as the plus button, growing out of the top of
the input. `/` lists tools first (Goal, Plan mode, Build mode, Computer use, Sketch, and Model), then
provider commands, then skills. `$` lists skills only. `@` lists tools, then project files and
folders. Keep typing to filter, use the arrow keys to move, and press Enter to choose.

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

Provider commands appear only when `/` starts the whole message, where the
provider can expand them. Tools remain available after `/` at the beginning of any line.
Choosing Computer use always places `/computer-use` at the start of the message.
Record a skill, in the Add menu or as `/record-skill`, appears when the environment is a Mac. See
[Record a skill](record-a-skill.md).

## Action palette

The action palette sits at the right of the conversation in web and desktop. When the
conversation becomes too narrow, including when you resize a neighboring pane, the palette
hides automatically. Toggle thread details to reopen it floating above the conversation
without squeezing messages or the composer. Widening the conversation restores the inline
layout. You can toggle the palette independently in each layout.

## Pending questions

The action palette lists pending questions for the current thread. Select a request to answer
it in the composer, even when the original question is earlier in the conversation. Requests
with several questions open together so you can answer each one before submitting.

Select the X beside a request to ignore it immediately. Native question forms also provide
Ignore and Undo; leaving the form cancels an unsent dismissal.

Ignoring removes the request from all connected clients without sending a follow-up message.
An agent waiting for an answer receives its provider's cancellation response. If delivery fails,
the question reappears so you can retry. The thread's Input marker clears when no pending input
remains. Ignore is available only when the connected environment supports question dismissal.

You can show, hide, and reorder Pending questions in the action palette settings.

# Returning to the latest message

When you scroll up in a thread, a button above the composer takes you back to the end.
It shows a down chevron while the thread is idle, or a working orb beside “working...”
while the agent is busy. The orb respects your reduced-motion preference.

On iOS, the button shows a still orb with the current activity, including “Working…”.
Queued work and requests waiting for your response use the down chevron. Tap the button
to return to the latest message and resume following new replies. The changed-files
bubble remains above the composer and opens the diff sheet.

## Claude model updates

Claude Opus 5.5 is available in the model picker when your environment runs Claude Code
2.1.280 or newer. It defaults to medium reasoning effort and a 1M context window,
with an optional Fast Mode toggle. Thinking is always enabled for this model.

With provider update checks enabled, Pathway refreshes its published model catalog
as part of provider checks, at most once per hour. Catalog updates can add Claude models,
change their options, and move models into or out of the legacy list without another
Pathway update. A new model can still require a newer Claude Code version or account access.
If the catalog cannot be downloaded, Pathway keeps its last good catalog or its bundled copy.
Connected web, desktop, and mobile clients use the catalog from their selected environment.

To fetch the latest catalog immediately, open **Settings → Providers**, select the
environment that runs your threads, and choose **Update model catalog**. This bypasses
the hourly cache and works with automatic provider update checks disabled. Pathway
confirms when the catalog is downloaded; if it fails, your existing models stay available.
This updates model definitions, not the Pathway app or the provider CLI.
