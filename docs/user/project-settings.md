# Project settings

## The project dashboard

Open **Projects** in the sidebar and select one. The dashboard shows where the project lives (every
machine and directory that has a checkout), its issue and milestone progress, who is carrying the
work, recent agent threads, open pull requests, and AI usage.

A project belongs to a company, not to a machine, so it appears here whether or not anything is
checked out. A project with no checkout is marked **No checkout**: you can plan and file issues
against it, and attach a directory later to run agents in it.

**Configure** opens the same editor as Settings → Projects, in a side panel.

AI usage is attributed by working directory, which is how the provider CLIs organise their
transcripts. Session time is wall clock from a session's first message to its last — a session left
open reads as a long one — and cost is what those tokens would bill at API rates, not what a
subscription charged. Codex stores its sessions by date rather than by directory, so its usage
cannot be attributed to a project.

## Settings → Projects

Open **Settings → Projects** to see every project and how many machine connections it has. Hover
the connection count to see each environment name, directory, platform, Pathway version, and
binding status.

Select a project and open **Connections** for the full list. Each connection identifies the
machine or environment, its attached directory, availability, environment ID, and last-seen time.
When a project has several active connections, **New-thread default** marks the environment Pathway
will use automatically.

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
