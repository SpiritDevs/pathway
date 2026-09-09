# Project connections

Projects belong to your personal workspace by default. Existing projects without an owner are
assigned there automatically, without a prompt when you start the app or sign in.

If you belong to a company, **Add project** shows a workspace dropdown above the creation options.
It starts with the company selected in your profile menu, or your personal workspace when
**All Companies** is selected. You can change it before creating the project. If your personal
workspace is your only workspace, the dropdown is hidden. Connecting to an existing project keeps
that project's owner.

Creating a project from **Agent Threads** selects it for the current unassigned draft. **Name only**
uses an internal [Pathway workspace](project-workspaces.md), so the thread is ready to use without
creating a folder in your home directory. You can attach your own directory later.

A Pathway project can have connections on several computers. Pathway normally joins checkouts
automatically when their Git repository matches.

To choose an available machine automatically for new threads, enable [load balancing](load-balancing.md).

If two project entries were created because their Git remotes disagreed, open the project you want
to keep in **Settings > Projects** and choose **Merge project**. Select the duplicate and then select
the correct Git repository. Pathway moves the duplicate's connections, threads, and issues into the
project you kept.

When **All Companies** combines matching checkouts owned by different companies, select the company
you want to work in before merging. If the same environment has active connections to both
projects, remove one of those connections first so future remote commands have one clear checkout.

The selected repository becomes authoritative for every connection. Online environments update the
checkout's Git remote immediately; offline environments apply the choice when they reconnect. Files
and branches in the checkout are not changed.
