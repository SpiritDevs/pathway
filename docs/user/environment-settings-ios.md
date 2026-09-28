# Environment settings on Apple clients

Open **Settings → Workspaces → Environments & providers** and choose an environment. The **Version** group at the top shows the version the environment is running. Choose **Check now** to look for a newer release. When one is available, choose **Notes** to read what changed, or **Update** to install it. The environment restarts to finish, which may interrupt running agent turns, and the version updates once it reconnects. Desktop hosts update through the desktop app's own release channel. Other hosts need the Pathway background service to update remotely; otherwise the group explains what to run on the host.

Open **Environment preferences** to change host settings. Changes apply to the selected host and its connected clients. Choose **Save settings** before leaving.

You can choose the default workspace for new threads, whether new worktrees start from origin, the directory used when adding projects, provider update checks, and the models used for generated text and context compaction.

Background policies control work on the host. Balanced, Performance and Battery saver set a complete policy. You can adjust Git-fetch and provider-health intervals, or expand the advanced controls for host-power monitoring, idle-client expiry and pause conditions. An interval of zero disables that refresh timer. Choosing a preset resets its custom overrides.

Open **Source control settings** to choose repository conventions, Conventional Commits or custom writing instructions for generated change descriptions. You can follow repository change-request templates and select a dedicated source-control writer model, or return to the general text model.

**Git tools & hosting accounts** shows installed version-control tools, hosting-provider availability and authentication status. Reveal an account name when needed. Follow the displayed installation or authentication guidance on the host, then choose **Rescan environment**. Credentials stay on the host.
