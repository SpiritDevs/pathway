# Project connections

Projects belong to your personal workspace by default. Existing projects without an owner are
assigned there automatically, without a prompt when you start the app or sign in.

If you belong to a company, **Add project** shows a workspace dropdown above the creation options.
It starts with the company selected in your profile menu, or your personal workspace when
**All Companies** is selected. You can change it before creating the project. If your personal
workspace is your only workspace, the dropdown is hidden. Connecting to an existing project keeps
that project's owner.

## Create a project

**Add project**, the sidebar's new-project button, and the command palette all open **Create
project**:

- **Name and icon.** The name defaults to the first folder's name. The icon button shows the icon
  detected in the first folder; open it to choose a built-in icon and color instead, which every
  device shows. **Use detected icon** switches back.
- **Focus.** The project joins the Focus you have open, or none from **All**. Change it before
  creating.
- **Folders.** Add one folder per environment that should run the project, using **Add
  environment** for each additional computer. The folder browser can create a new folder. With no
  folder, the project uses an internal [Pathway workspace](project-workspaces.md) until you attach
  one.
- **Source.** **Folders** links each folder as it is. **Clone repository** clones an `owner/name`
  repository or Git URL into every folder. **New GitHub repository** creates the repository once,
  under your account or one of your organizations, public or private, in the first folder; every
  other folder clones it so all computers share one history. Creating a repository uses the GitHub
  CLI signed in on the first folder's computer.

Creating a project from **Agent Threads** selects it for the current unassigned draft. If setup
stops partway, the project keeps whatever was created; finish the remaining folders from its
**Connections** settings.

To change a project's icon later, open its settings and use **Choose icon** beside **Project
icon**.

On iPhone and iPad, choose **New Project** from the Focus menu in **Thread options**, or from the
**Projects** screen. The sheet offers the same name, icon, Focus, company, source, and environment
choices; use **Browse** to pick each folder. A project's **Icon** row in its settings sets or clears
its built-in icon.

A Pathway project can have connections on several computers. Pathway normally joins checkouts
automatically when their Git repository matches.

In web and desktop, threads belonging to the same project share an icon from an available
connection. A built-in icon chosen for the project takes priority, then a configured custom icon
file, followed by the preferred connection.
If that computer disconnects, Pathway uses another available connection.

To choose an available machine automatically for new threads, enable [load balancing](load-balancing.md).

If two project entries were created because their Git remotes disagreed, open the project you want
to keep in **Settings > Projects** and choose **Merge project**. Select the duplicate and then select
the correct Git repository. Pathway moves the duplicate's connections, threads, and tasks into the
project you kept.

When **All Companies** combines matching checkouts owned by different companies, select the company
you want to work in before merging. If the same environment has active connections to both
projects, remove one of those connections first so future remote commands have one clear checkout.

The selected repository becomes authoritative for every connection. Online environments update the
checkout's Git remote immediately; offline environments apply the choice when they reconnect. Files
and branches in the checkout are not changed.

To remove a project, open its settings and scroll to the red-tinted **Danger** card at the bottom.
Choose **Remove project**, then review the confirmation before continuing. **Cancel** keeps the
project. Removing a project deletes its entry and threads; files on disk are not touched.
