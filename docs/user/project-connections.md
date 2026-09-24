# Project connections

Projects belong to your personal workspace by default. Existing projects without an owner are
assigned there automatically, without a prompt when you start the app or sign in.

If you belong to a company, **Add project** shows a workspace dropdown above the creation options.
It starts with the company selected in your profile menu, or your personal workspace when
**All Companies** is selected. You can change it before creating the project. If your personal
workspace is your only workspace, the dropdown is hidden. Connecting to an existing project keeps
that project's owner.

## Create a project

**Add project**, the sidebar's new-project button, and the command palette all open **New
project**:

- **Name and icon.** The name defaults to the first folder's name. The icon button shows the icon
  detected in the first folder; open it to choose a built-in icon and color instead, which every
  device shows. **Use detected icon** switches back.
- **Focus.** The project joins the Focus you have open, or none from **All**. Change it before
  creating.
- **Folders.** Browse from your home folder (`~/`) and choose **Attach**, or create a new folder.
  Add one folder per environment using **Add environment**. Environments already selected are
  excluded from the other dropdowns; the add button disappears once all connected environments
  have a folder. With no folder, the project uses an internal
  [Pathway workspace](project-workspaces.md) until you attach one.
- **Git.** Pathway checks each attached folder for Git. Checkouts of the same repository can be
  linked across environments, but attaching a different repository shows an error. Folders
  without Git can be attached alongside a repository.
- **Create Git Repository.** When all attached folders have been checked and none contains Git,
  enable this switch to show the GitHub owner, name, and visibility options. The repository is
  created once in the first folder; every other folder clones it and must be empty. Creating a
  repository uses the GitHub CLI signed in on the first folder's computer.

Creating a project from **Agent Threads** selects it for the current unassigned draft. If setup
stops partway, the project keeps whatever was created; finish the remaining folders from its
**Connections** settings.

To rename a project, open **Settings > Projects**, edit **Name**, then press Enter or leave the
field. The name applies to all of the project's connections, including when you choose the same
name as its folder or Git repository.

To change a project's icon later, use **Choose icon** beside **Project icon** for a built-in icon,
or **Choose file** for an image in the project's folder. A chosen file is uploaded once (up to 1 MB)
and replaces any built-in icon. Either choice is saved with the project, so every device and every
connection shows the same icon, even when the computer holding the file is offline. The reset
button beside **Project icon** returns to the detected icon.

On iPhone and iPad, choose **New Project** from the Focus menu in **Thread options**, or from the
**Projects** screen. The sheet offers name, icon, Focus, company, source, and environment
choices; use **Browse** to pick each folder. A project's **Icon** row in its settings sets or clears
its built-in icon.

A Pathway project can have connections on several computers. Pathway normally joins checkouts
automatically when their Git repository matches.
The project picker lists each project once across its connected environments. Selecting a project
shows its threads from every environment, including checkouts with different folder names or no Git repository.

Threads belonging to the same project share one icon. A built-in icon or uploaded image chosen for
the project always takes priority. Without one, web and desktop use the icon detected in an
available connection, starting with the preferred connection. If that computer disconnects or cannot
load the image, Pathway tries another available connection.

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
