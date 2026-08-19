# Project settings

## The project dashboard

Open **Projects** in the sidebar and select one. The dashboard shows where the project lives (every
machine and directory that has a checkout), its issue and milestone progress, who is carrying the
work, recent agent threads, open pull requests, and AI usage.

A project belongs to a company, not to a machine, so it appears here whether or not anything is
checked out. A project with no checkout is marked **No checkout**: you can plan and file issues
against it, and attach a directory later to run agents in it.

**Configure** opens the same editor as Settings → Projects, in a side panel. It is also where you
move a project to another company.

## Moving a project to another company

A project can move, and its issues and milestones move with it. Because statuses, labels, and issue
keys all belong to the company, the move is a migration rather than a setting, so it runs as a
stepper: choose the destination, map each status and label onto one in the new company, then review.

Pathway fills in the mappings whose names match and leaves the rest blank — a wrong guess that looks
confident is worse than an empty field. What does not survive is stated on the review step:

- **Issue keys are re-issued** under the new company's prefix. Any key you have linked or quoted
  stops resolving, and this cannot be undone.
- **Cycles are left behind**, because a cycle spans a whole company rather than one project.
- **Team visibility resets** — issues arrive company-wide.
- **Unmapped labels are removed** from their issues.

AI usage is attributed by working directory, which is how the provider CLIs organise their
transcripts. Session time is wall clock from a session's first message to its last — a session left
open reads as a long one — and cost is what those tokens would bill at API rates, not what a
subscription charged. Codex stores its sessions by date rather than by directory, so its usage
cannot be attributed to a project.

## Settings → Projects

Open **Settings → Projects** to see every project and how many machine connections it has. Hover
the connection count to see each environment name, directory, platform, Pathway version, and
binding status.

The profile or company selector at the top of Settings only filters what Settings shows. Deleting
a project uses its recorded company ownership, so you do not need to select an owning company
first.

Select a project and open **Connections** for the full list. Each connection identifies the
machine or environment, its attached directory, thread count, availability, environment ID, and
last-seen time. Select a connection to configure its grouping and actions. Its action menu can copy
the directory path or remove that connection; Pathway disables removal when it is the project's
only connection.
When a project has several active connections, **New-thread default** marks the environment Pathway
will use automatically.

Removing a project does not require any of its machines to be online. Pathway removes the shared
company project immediately; each offline checkout removes its local project and conversation
history when that environment reconnects. Project files and directories on disk are never deleted.

## Customize a project icon

Pathway selects a project icon automatically. It checks `pathway.json`, common favicon and app icon
paths, and icon links in project HTML files.

To choose a different icon:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Under **Appearance**, select **Choose a project file**.
4. Search for an image file and select it.

Pathway supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.
