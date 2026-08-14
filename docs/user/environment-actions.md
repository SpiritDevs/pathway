# Environment actions

Open the thread details menu in a thread header to see workspace actions and live resources for
that thread's environment.

When a thread is related to any issues, an **Issues** section sits directly above **Version
Control** and lists each of them with its key, title, status, priority, and due date. Select an
issue row to open its full detail sheet.

When local development servers are listening, the **Development environments** section shows their
process names and localhost ports. Expand **Local servers**, then choose a server to open it in
Pathway's browser panel. Hover a server to open it, copy its URL, or stop its owning process. Stop is
unavailable when the environment cannot identify that process safely.

Use **Settings → General → Development server ports** to choose the inclusive port range Pathway
shows across its development-server lists. The default range is `3000` through `9999`.

When the current thread has active terminal sessions, the **Terminals** section lists them under
**Running terminals**. Choose a terminal to return to it in the terminal drawer or right panel.

The **Thread** section includes **Hand off…** after the chat has a completed agent response. Choose
another provider or model to continue the same chat. The next message carries the conversation
context into that provider while keeping the handoff visible in the thread history.

Completed agent responses also have a **Continue in a new chat** action. Choose the model for the
new chat, then continue in the current checkout or a new worktree. A new worktree starts from the
source checkout's committed `HEAD`; uncommitted files remain only in the source checkout.

Branch pickers show local branches and remote-qualified refs separately, such as `main`,
`origin/main`, or `upstream/main`. When a new worktree starts from the remote version of a branch,
Pathway fetches that selected remote first. If the branch name is local, Pathway uses `origin` when
available and otherwise uses the repository's first configured remote.

On a new thread, **Usage** shows every enabled provider account that supports live quota reporting,
so you can compare remaining allowance and reset times before choosing a provider. Changing the
provider picker does not refresh these limits. After the thread starts, **Usage** follows the active
provider. Providers with multiple limits can be expanded to see every window and any credit balance
reported by that provider.

The bottom of **Settings → Providers** shows the same limits for every supported account on the
selected environment. Provider credentials remain on the environment that owns them.

The profile menu's **Provider usage** submenu shows supported accounts from every environment that
is currently connected. Accounts stay grouped by environment so limits from different machines or
sign-ins are not combined.

For remote projects, both lists describe processes running in the remote environment rather than on
the device displaying Pathway.
