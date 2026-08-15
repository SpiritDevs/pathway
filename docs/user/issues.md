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

When a linked work thread opens a pull request, its numbered badge appears on both the list row and
the board card. Select the badge to open the pull request on its source-control host.

Right-click a row or a board card for the same properties in one menu: **Status**, **Priority**,
**Assignee**, **Labels**, **Project**, **Milestone**, **Cycle**, and a **Due date** with the four
dates worth one press. Below those sit **Investigate**, **Copy** (issue ID, title, link, or a
markdown link), **Remove** for any property the issue is carrying, and **Delete**. Right-clicking a
row that is part of a selection acts on the whole selection; anywhere else it acts on the one row.
**Milestone** is only offered when the targets share a project, since a milestone belongs to one.

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

The sidebar also gives you **Triage** with its pending count, **Milestones**, **My issues**,
**Projects** (expanding to their milestones), **Cycles**, and **Labels**. A milestone under a
project opens that milestone's own page rather than filtering the list.

### The detail sheet

Opening an issue slides a sheet in from the right and leaves the list visible behind it, so you can
work down a queue without losing your place. Click outside the sheet or press `Escape` to close it.

The sheet holds the description, the properties rail, todos, sub-issues, relations, comments, the
investigation panel, and the activity feed. Every change to an issue is recorded in that feed with
who made it and what it was before. On wider sheets, drag the divider beside the properties rail to
resize it; Pathway remembers the width for the next issue you open. Click the issue key in the
sheet header to copy it. When you follow a sub-issue or relation inside the sheet, use the back and
forward buttons beside the issue key to move through the issues you visited.

A pull request discovered on a linked work thread also appears in the properties rail with its
title and current open, closed, or merged state. The first discovery is recorded automatically in
the activity feed as an Automation event.

Use **Add images** in the attachment shelf to choose images from a file or from the clipboard. You
can also paste an image directly into the description; Pathway moves it into the attachment shelf
instead of inserting it into the description.

Clicking an image — in the shelf or in a comment — opens it full window inside Pathway rather than
in a browser. The viewer holds every image on the issue, so the arrows, the thumbnail strip, and the
left and right arrow keys walk the whole set. From there you can zoom (the buttons, `+`, `-`, and
`0`, or double-click, and drag to pan), download or copy the image, open it in a browser, start a
new thread about that one image, or comment on it without leaving the viewer. `Esc` closes it.

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
position you set by dragging, and one of six categories: Backlog, Unstarted, Started, Review,
Completed, Canceled. Review is active pre-completion work: it stays in counts and rollups without
being treated as done. The category is what matters — it drives the Active and Backlog tabs,
milestone and sub-issue progress, and what an agent understands "done" to mean.

The same page holds the **issue key prefix**: the letters in front of every issue number, like
`PAT-12`. New issues take the current prefix. Keys already handed out keep the prefix they were
created with, and an issue keeps its key when you move it between projects.

**Settings → Issues → Labels** manages labels, which are flat and coloured. You can also create one
inline while labelling an issue.

## Planning: milestones, cycles, sub-issues, todos, and relations

- **Milestones** are named checkpoints inside a project, with an optional start date and target
  date. Progress rolls up from the statuses of the issues on them, and they have pages of their
  own — see below.
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

### Managing milestones

**Settings → Issues → Milestones** lists them grouped by project. Each row holds the name, a start
date, a target date, how far it has got, and a handle for dragging it into order within its project;
the last row of each group adds a new one, so a project with no milestones still has a way in. A
start date after the target is refused and the field goes back to what it was.

Deleting a milestone that holds no issues goes straight through. Deleting one that holds issues asks
first: those issues stay exactly as they are, in the same project, with no milestone.

### The milestones overview

**Milestones** in the Issues sidebar shows every milestone grouped by project, with a project filter
and a **List** / **Timeline** toggle. Both live in the address, so the view you are looking at is
the view you can send someone.

Each list row carries a status — **Upcoming**, **In progress**, **Completed**, or **Overdue** —
worked out from the dates and the issues rather than set by hand, a progress meter with a done/total
count, the date range, and a menu to rename, edit the dates, move it to another project, or delete
it. Every project group ends with a **New milestone** row.

Moving a milestone to another project asks first when it holds anything: an issue belongs to its
project, so the milestone travels alone and the issues it leaves behind end up unassigned.

The timeline draws one bar per milestone over a **week**, **month**, or **quarter** scale, grouped
by collapsible project lanes with today marked. Drag a bar's left edge to move its start date, its
right edge to move its target, or its body to move both — dates snap to whole days, and an end
dragged past the other stops on it. Milestones with no dates wait in the **Unscheduled** tray above
the grid: drag one onto a lane to schedule it, and drop a scheduled bar back into the tray to clear
its dates again. Every bar and every tray chip is also a button that opens both dates as fields with
a **Clear dates** next to them, so nothing on the timeline needs a mouse.

### A milestone's page

Clicking a milestone anywhere — the overview, the timeline, or under a project in the sidebar —
opens its own page: the name and both dates editable in place, the derived status, a progress meter,
a description, and every issue on the milestone in the usual list, opening into the usual detail
sheet.

Four readings sit above the issues: **Completed** as a count, **Days remaining** to the target,
**Pace** in issues finished per day so far, and a **Projected finish** at that pace, badged **On
track**, **At risk**, or **Behind** in words as well as colour. A milestone that has finished
nothing yet reads **No pace yet** rather than guessing.

The **burn-up** below the tiles plots completed work against the milestone's total scope over time,
so work added mid-flight shows up as the ceiling rising instead of disappearing into a percentage.
When both dates are set, a dashed **ideal pace** line runs from the start date to the target, and
the gap between the two lines is the answer to "are we going to make it?". Hover any day for its
numbers, or walk the days with the arrow keys.

Pathway rebuilds that history from the issue activity log, so two things are worth knowing: it only
sees the issues that are on the milestone now — one moved off it leaves no trace behind — and if a
status or the milestone itself has been renamed since, the chart says the history is partly a guess
instead of pretending otherwise.

### Browser evidence from agents

An agent working from an issue can attach its browser verification directly to the issue instead
of leaving the proof inside its conversation. Screenshots appear inline, and short Preview
recordings play in the comment and in the issue's attachment shelf. The comment remains attributed
to the agent and should explain what it verified, what the evidence demonstrates, and any known
limitations.

For a video, the agent starts and stops a Preview recording, then attaches the returned recording
to the issue. Pathway copies that recording into the environment's issue attachment store, so it is
still available when the issue is opened from another device or over a remote connection.

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
start anything. Model, reasoning, and workspace controls appear beside **Start new thread**, with
the model constrained to the assigned provider and initially using a compatible project default.
Choose **Current checkout** to work in the project's main workspace, or **New worktree** and select
the branch it should start from. Pressing the button creates a fresh thread, sends the
issue's title, description, todos, links, and images as its first turn, and starts the agent. New
worktrees also run the project's configured setup tasks. The new thread lists the originating issue
under **Issues** in its details menu, where the current status and priority stay visible and the
full detail sheet is one click away. Its issue code also appears in the thread sidebar card and
hover details; select the code there to open the issue directly. Dragging cards around a board never
launches an agent.

That **Issues** section covers every issue the conversation is related to, not just the one it
started from: the issue it was started from, any an agent attached while it worked, and any
mentioned in the chat. Each issue appears once however many times it comes up, and an issue that
has since been deleted is listed with a **Deleted** label rather than quietly dropped.

Use the arrow beside **Start new thread** and choose **Create pending thread** when you want to
prepare the same prompt, model, images, and workspace without sending the first turn. The pending
thread opens in the composer so you can review or edit it before submitting it.

Choose **Talk about issue** under **Actions** to open a pending discussion thread even when the
issue is not assigned to an agent. Add your question to the prepared issue context, then send it
when you are ready. The agent links the thread to the issue and keeps the ticket current as the
conversation produces decisions, without starting implementation unless you ask.

When the issue came from an intake channel with **Auto-assign worker** enabled, Pathway saves the
selected provider, model, and reasoning level on the issue. **Start new thread** opens with that
exact selection. The worker prompt also names the configured review status, so the agent can move the
issue there with the issues tools once implementation and verification are genuinely complete.

### Investigate

**Investigate** on an issue runs the configured model once over the project's directory in
read-only mode and records what it found as an **Investigation** comment:

- the problem restated,
- the files the work probably lands in,
- related issues,
- suggested labels and a priority,
- a more specific title when an integration supplied the original one.

Pathway applies the priority and appends the agent's summary to the bottom of the description,
separated from the original report by a blank line. For Slack intake, the source message stays
below a **Slack comment** label and the investigation replaces Slack's generated title
with a specific description of the job. A title created or edited by you is never replaced without
confirmation, and labels remain suggestions you apply.

The run cannot edit, stage, or commit anything. One investigation runs at a time and a second
queues behind it. You will see the live transcript in the issue's investigation panel.

Investigate is unavailable when the issue has no project, when its project has no directory
attached, or when a run is already in flight — the button says which. It never runs on import.

**Settings → Issues → Enrichment** picks the model investigations use. It defaults to your text
generation model, and changing it here does not change that one.

### Mentioning an agent in a comment

You can ask an agent something directly from an issue's comment thread. Mention it either way:

- **Type it** as an ordinary markdown link naming a configured agent — `[Claude](Claude)` works,
  and so does `[@Claude](claude)`; case does not matter and a leading `@` is decoration.
- **Pick it** by typing **@** in the composer. The agent list opens immediately and filters as you
  type; use the arrow keys and Enter or click an agent. The **@** button below the composer opens
  the same configured-agent list without typing.

Either way a chip appears next to the composer showing the agent and its model. Click the chip to
configure the run — provider instance, model, reasoning effort, and service tier, the same options
a chat turn has — or dismiss it to send a plain comment. Choosing from the inline picker consumes
the unfinished `@query`; the persisted mention becomes a pill only when the comment posts.

Posting the comment starts **exactly one run** for that comment. The agent reads the issue — title,
description, and the comment thread including your ask — and works in the project's directory
read-only. Under your comment you'll see where it is: _waiting to start_, _thinking_, _researching
the project_, _writing reply_, and finally how long it took. **Cancel** stops a queued or running
run; a failed or canceled run offers **Retry**, which starts a fresh run with the same
configuration. **Execution details** holds the live transcript, collapsed by default.

The agent's answer arrives as a normal comment attributed to it, exactly like any other agent
comment in the feed. When the reply calls for it, the run may also set the issue's priority, fill
in an empty description, or replace a placeholder title — every such change is attributed in the
activity feed. It never overwrites a title or description you wrote.

A few boundaries worth knowing: one mention per comment (the first one wins), editing a comment
never re-dispatches its run, deleting the mention comment cancels the run, and a mention needs the
issue to be in a project with a directory attached — without one the run fails and says why.
Mentions are a web and desktop feature; there is no issues surface on mobile.

### Agents reading and writing issues

Coding agents get an issues toolkit automatically, whichever provider you use. They can search and
read issues, create and update them, comment, delete, and restore, and link the thread they are
working in to an issue. They can also list, create, rename, reschedule, move, and delete milestones.
Milestone tools identify one by its project and name, since the same name may exist in two projects.
When an agent creates an issue with a project and names a milestone that does not exist there yet,
Pathway creates the milestone while filing the issue and assigns the new issue to it.

Issue reads include every image attachment in the issue-level attachment list and on the comment
that owns it, together with that comment's body, author, and timestamp. Pathway sends a bounded set
of those images directly with the issue read so the agent can inspect them visually. If an issue has
more images than fit safely in that response, the agent can read any remaining image individually
with its attachment id. Issue attachments are images only.

Agent writes are not gated behind an approval, so treat them like your own. Issue deletes are soft
and reversible with **Restore**, and issue writes are attributed in the activity feed with the
provider that made them. Milestone changes appear immediately, but milestones have no activity feed
of their own.

### Issue keys in chat

Write an issue key like `PAT-12` in a chat message and, once that message is finished, the key
becomes a link that opens the issue. It works the same way in what you send and in what the agent
writes back, so a plan naming four tickets gives you four ways into the tracker. Mentioned issues
also join the thread's **Issues** section in the details menu, so the conversation keeps a record of
everything it touched.

Only keys that match a real issue in this tracker become links. Anything that merely looks like a
key — a branch name, a filename, a key from somebody else's tracker — stays plain text, so a link is
never an invitation to a page that does not exist. Keys written inside code blocks or inline code
stay plain too, since a key there is usually part of a path or a command rather than a reference.

Conversations you already have are covered as well: Pathway reads back through finished messages
once, so a key you wrote last month links exactly like one you write today.

Linked keys are a web and desktop behaviour. Mobile shows the key as plain text for now.

## Slack intake

Pathway can watch Slack channels, turn messages into issues, and post back into the source thread.

### What you need first

1. A Slack app in your workspace with a **bot token** (it starts with `xoxb-`), installed to the
   workspace and invited to each channel you want watched.
2. These bot scopes: `channels:history`, `channels:read`, `chat:write`, `files:read`,
   `groups:history`, `groups:read`, `reactions:read`, `users:read`.

Add the scopes under **OAuth & Permissions**, then reinstall the Slack app to the workspace so the
new permissions reach the bot token. Invite the bot to each channel (for example, with Slack's
`/invite @bot-name` command), then paste the token into **Settings → Issues → Triage & Intake**.
Saving verifies the token; opening the channel picker and the first poll verify the channel scopes.
The token is stored on the machine running Pathway and is never sent back to the app, which is why
the field stays empty afterwards.

### Watched channels and triggers

Add the channels you want watched, then set its **default project**, optional **release cycle**, and
whether matching messages should be investigated automatically. Every issue filed from the
channel takes that release cycle. Automatic investigation starts while the issue is still in
Triage; it does not accept the issue or move it onto a board.

Choose what files an issue from each channel. Any combination of these triggers works:

- **Reaction rules** — someone adds an emoji you nominate, such as `ticket`, to a message. A
  channel can have several rules. Each rule can inherit or override the channel's project and
  automatic-investigation setting.
- **Any new message** — every new human message posted in the channel.
- **Bot is mentioned** — messages that @-mention the bot.

Reaction rules are checked in their visible order. The first matching reaction wins, ahead of the
two general triggers. That makes one shared intake channel able to route `:quotecloud:` to the
QuoteCloud project and `:ve:` to the VE project while keeping a channel-wide fallback.

Turning every trigger off pauses a channel without removing it.

### Automatic assignment and review

Turn on **Auto-assign worker** for the channels that should use automatic routing. At the bottom of
**Triage & Intake**, configure:

- the routing model, ordered worker rules, and an optional fallback worker;
- audit rules, each with one or more independent auditor models;
- ordered review workers that can fix blocking audit findings;
- the statuses used when work starts, work enters review, every audit passes, or an audit requests
  changes; and
- a remediation limit that stops repeated worker-reviewer disagreement from looping forever.

The routing model sees the issue and the rules, then saves the matched rule, exact worker model,
audit policies, and its explanation on the issue. Assignment does not start a thread by itself.
When work starts, the issue moves to the configured work status. The worker moves it to the
configured review status when it is finished, which starts every selected audit independently.
Leaving a transition on its automatic choice uses the first Started status, the first Review
status, the previous Started status after a failed audit, and the next status after a passing audit.

All auditors must pass. Their separately attributed results are comments on the issue so differing
opinions remain visible. If any auditor finds a concrete blocking problem, the issue returns to the
configured changes-requested status and the combined findings are sent to the linked worker thread.
Configured review workers run there in order; with none configured, the original worker handles
the findings. The last review worker moves the issue back to review after fixing and verifying the
work, which starts a new deduplicated audit cycle. Passing moves it to the explicitly selected
status or, by default, the next status in workflow order — commonly Pending Human Review or Done.

An automatic investigation needs the resolved project to have a directory attached. If it cannot
start, the issue is still filed and remains available to investigate by hand.

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
investigation at the same time when one has not already been started by Slack routing (unavailable
if the item has no project, or its project has no directory). Accepting several at once applies one
choice to the selection.

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

- **Mobile.** The Issues workspace is web and desktop only for now, milestone planning included.
- **Per machine.** There is no combined view across environments — each machine has its own
  tracker, its own key prefix, and its own Slack configuration.
- **Polling costs a call.** Every watched channel costs one Slack API call every thirty seconds
  while Pathway is awake.
- **Investigations spend tokens.** They run your configured model, so they only start when you
  press Investigate, tick the box while accepting a triage item, or enable automatic investigation
  for the Slack route that filed it.
