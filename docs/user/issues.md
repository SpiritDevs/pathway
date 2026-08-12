# Issues

Pathway has a built-in issue tracker at **Issues** in the sidebar. It holds the work you are
planning, the work an agent is doing, and the requests arriving from Slack, in one place next to
your threads.

Issues belong to the environment you are connected to. Connect to a different machine and you see
that machine's tracker.

## The Issues workspace

### List and board

The **List** is the default. Issues are grouped with collapsible headers and a count on each group,
and the whole list stays fast at thousands of rows.

- Move the cursor with `j` / `k` or the arrow keys, and press `Enter` to open the highlighted issue.
- Click a property on a row — status, priority, assignee, labels — to change it without opening
  anything.
- Shift-click to select a range. A bar appears with bulk **Status**, **Priority**, **Labels**, and
  **Delete** for everything selected. `Escape` clears the selection.

The **Board** shows one column per status. Drag within a column to reorder; drag across a column to
set the status and the position in one move.

Use the view options next to the list/board toggle to group the list by **Status**, **Project**,
**Priority**, **Assignee**, or **No grouping**, and to order by **Manual**, **Priority**,
**Last updated**, or **Created**. The board is always columns of statuses — grouping is a list
concern only.

The **Active**, **Backlog**, and **All** tabs are driven by each status's workflow category, not by
a list you maintain.

### Creating an issue

The new-issue composer keeps the title and description together with the properties you use most:
status, priority, assignee, project, and labels. Use the **More** button for milestones, cycles,
and parent issues.

Use the paperclip to add up to eight images. You can also paste images into the description or drag
them anywhere over the composer. Pathway shows a preview before creating the issue, then adds the
images to its comment thread so they remain visible in the detail sheet.

### Filters and saved views

The filter bar filters on **Status**, **Project**, **Label**, **Milestone**, **Cycle**,
**Assignee**, **Priority**, and **Due date**. Several values inside one chip match any of them;
separate chips all have to match. There is no nesting and no "not".

When a filter, grouping, and order describe something you will want again, save it as a named view.
Saved views appear in the Issues sidebar; selecting one puts the filters back exactly as you left
them. Drag to reorder them, and rename or delete from the row's menu.

The sidebar also gives you **Triage** with its pending count, **My issues**, **Projects**
(expanding to their milestones), **Cycles**, and **Labels**.

### The detail sheet

Opening an issue slides a sheet in from the right and leaves the list visible behind it, so you can
work down a queue without losing your place. `Escape` closes the sheet.

The sheet holds the description, the properties rail, todos, sub-issues, relations, comments, the
investigation panel, and the activity feed. Every change to an issue is recorded in that feed with
who made it and what it was before.

Deleting an issue is recoverable — it disappears from the list but keeps its key and its history,
and **Restore** brings it back.

## Projects without a directory

You can create a project by typing a name. It does not need a folder on disk, which means you can
plan work before the code exists.

A project with no directory is visible everywhere a project is visible. The first time you do
something that genuinely needs a path — starting a thread in it, a Git action, the file explorer,
running an investigation — Pathway asks you to set a directory and then continues what you were
doing. Nothing is hidden from you until then.

## Statuses, labels, and issue keys

**Settings → Issues → Statuses** is where the workflow lives. Each status has a name, a colour, a
position you set by dragging, and one of five categories: Backlog, Unstarted, Started, Completed,
Canceled. The category is what matters — it drives the Active and Backlog tabs, milestone and
sub-issue progress, and what an agent understands "done" to mean.

The same page holds the **issue key prefix**: the letters in front of every issue number, like
`PAT-12`. New issues take the current prefix. Keys already handed out keep the prefix they were
created with, and an issue keeps its key when you move it between projects.

**Settings → Issues → Labels** manages labels, which are flat and coloured. You can also create one
inline while labelling an issue.

## Planning: milestones, cycles, sub-issues, todos, and relations

- **Milestones** are named checkpoints inside a project, with an optional target date. Progress
  rolls up from the statuses of the issues on them.
- **Cycles** are named date ranges that span everything, and you create them yourself. When a cycle
  ends its completed set freezes; unfinished issues move to the next cycle if one exists, and
  otherwise end up in no cycle.
- **Sub-issues** are real issues with their own status, assignee, and key. A parent shows its
  children's progress as a count like `3/9`. You can nest three levels deep.
- **Todos** are a plain checklist on the issue — text, a checkbox, an order. Use these for steps
  that do not deserve their own issue.
- **Relations** link two issues as **blocks**, **blocked by**, **related**, or **duplicate**. Add
  one from either end and the other end shows the matching side automatically.
- **Comments** support the same rich composer as the chat, and you can attach images.

## Importing from Linear

**Settings → Issues → Import** takes a Linear CSV export as-is. It reads the exported keys, titles,
descriptions, statuses, priorities, labels, created and updated dates, due dates, and parent links,
and shows you which column it mapped to what before you commit.

A status your tracker has never seen is created for you, and its workflow category is guessed from
its name — check the Statuses page afterwards and correct anything it got wrong. Nothing is
investigated on import.

## Agents and issues

### Assigning an agent

An issue can be assigned to you or to an agent. Assigning an agent records the intent; it does not
start anything. A **Start work** button appears on the issue instead, and pressing it opens a
thread seeded with the issue's title, description, todos, and links. Dragging cards around a board
never launches an agent.

### Investigate

**Investigate** on an issue runs the configured model once over the project's directory in
read-only mode and appends what it found to the description as an **Investigation** block:

- the problem restated,
- the files the work probably lands in,
- related issues,
- suggested labels and a priority.

The suggestions are chips you press. Nothing on the issue changes by itself except that block.

The run cannot edit, stage, or commit anything. One investigation runs at a time and a second
queues behind it. You will see the live transcript in the issue's investigation panel.

Investigate is unavailable when the issue has no project, when its project has no directory
attached, or when a run is already in flight — the button says which. It never runs on import.

**Settings → Issues → Enrichment** picks the model investigations use. It defaults to your text
generation model, and changing it here does not change that one.

### Agents reading and writing issues

Coding agents get an issues toolkit automatically, whichever provider you use. They can search and
read issues, create and update them, comment, delete, and restore, and link the thread they are
working in to an issue.

Agent writes are not gated behind an approval, so treat them like your own: deletes are soft and
reversible with **Restore**, and every write is attributed in the activity feed with the provider
that made it.

## Slack intake

Pathway can watch Slack channels, turn messages into issues, and post back into the source thread.

### What you need first

1. A Slack app in your workspace with a **bot token** (it starts with `xoxb-`), installed to the
   workspace and invited to each channel you want watched.
2. These bot scopes: `channels:history`, `channels:read`, `chat:write`, `users:read`,
   `reactions:read`, `files:read`.

Paste the token into **Settings → Issues → Triage & Intake**. Saving tests the connection, so a
token missing a scope is refused there rather than failing quietly later. The token is stored on
the machine running Pathway and is never sent back to the app, which is why the field stays empty
afterwards.

### Watched channels and triggers

Add the channels you want watched, then choose what files an issue from each one. Any combination
of three triggers works:

- **A reaction** — someone adds an emoji you nominate, such as `ticket`, to a message.
- **Every message** — everything posted in the channel.
- **Bot mentions** — messages that @-mention the bot.

Turning all three off pauses a channel without removing it.

Each channel can map to a project, and everything filed from that channel is tagged with it.

Channels are polled about every thirty seconds, each from its own position. A machine that was
asleep catches up on what it missed rather than losing it. Watching a channel starts from now: the
first poll files nothing, so you do not get the channel's whole history dumped into triage. A
reaction can reach back about a week or a hundred messages, whichever comes first.

The settings page shows when each channel was last polled and reports the first error of a cycle. A
bot removed from one channel does not stop the others being read.

### The triage queue

A message becomes a **triage item**: an issue with no status, on no board, in no count, waiting for
a decision. The Triage entry in the Issues sidebar carries the pending count, and each row shows
which channel it came from and how long it has been waiting.

**Accept** assigns a status, a project, and a priority in one step, and offers to start an
investigation at the same time (unavailable if the item has no project, or its project has no
directory). Accepting several at once applies one choice to the selection.

**Reject** removes the item from the queue, with an Undo that puts it back in triage rather than
into the workflow.

When an item is filed, the bot replies once in the source thread with the issue key and a link to
open it in Pathway.

### Two-way replies

Once an issue has a Slack source:

- Replies in that Slack thread arrive as comments on the issue, with any images attached.
- Comments you or an agent add in Pathway are posted back into that thread.
- Status changes are posted back too, attributed — "Claude moved PAT-12 to In Review".

Comments and status changes are the only things that cross back. The bot recognises its own posts,
so the two sides cannot bounce a message back and forth.

The issue's Slack origin is shown as a chip in the detail sheet, which takes you to the original
message.

## Notes and limits

- **Mobile.** The Issues workspace is web and desktop only for now.
- **Per machine.** There is no combined view across environments — each machine has its own
  tracker, its own key prefix, and its own Slack configuration.
- **Polling costs a call.** Every watched channel costs one Slack API call every thirty seconds
  while Pathway is awake.
- **Investigations spend tokens.** They run your configured model, so they only ever start when you
  press Investigate or tick the box while accepting a triage item.
