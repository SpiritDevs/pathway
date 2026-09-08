# Balance new threads across machines

Auto balance chooses a connected machine with available CPU and memory when you start a new thread. It is off by default.

On web and desktop, open **Settings → Environments → Load balancing**. On iOS, open **Connections → Load balancing**. Enable **Auto balance new threads**, then choose a preference for each machine:

- **Prefer** gives the machine more weight when resources are available.
- **Normal** uses the standard weight.
- **Less often** reduces its weight.
- **Manual only** excludes it from automatic placement. You can still select it yourself.

These are preferences, not fixed percentages. They are saved separately on each client.

Machines must have active connections to the same project in the same company, an available provider, and permission to start threads. On web and desktop, the destination must support your selected provider, model, and options. On iOS, the first choice happens when you select a project; rechecking an existing selection preserves a compatible provider and model. Auto keeps the current checkout when it selects the current machine. If another machine has multiple connected checkouts of the project, select its checkout manually. Grouping unrelated projects together in the sidebar does not make them eligible.

On web and desktop, each new project thread starts with an automatic choice when load balancing is enabled. The location dropdown shows **Auto: <machine name>** as its first option, followed by a separator and the project’s environments. Select an environment to override Auto, or select Auto to return to the suggested machine. The dropdown stays available while you prepare the draft, including after choosing a branch, worktree, account, or attachments. If Auto cannot find an eligible destination, choose a machine explicitly before sending. A machine that is offline, too busy, or unable to report its resources can be unavailable for automatic placement.

On web and desktop, Auto uses a compatible provider and model even when your draft inherits a custom account. Restored file uploads without a local copy keep Auto on the machine holding the upload. If you manually choose another machine, reattach those files before sending. Switching environments resets the branch and any existing worktree path for the destination, while keeping your choice to create a new worktree. A launch also keeps its destination when you retry after a connection error. If attachment preparation fails before launch, you can choose a machine again. Existing threads continue on their original environment.

On iOS, account, workspace, branch, and attachment choices keep the draft on its machine. You can explicitly return an empty draft to Auto after removing its attachments and branch and selecting Current checkout. Auto preserves compatible model options but may choose another account. Drafts with a pending launch stay on their original machine.

Auto balance uses the providers configured on each machine. It does not combine subscription allowances or automatically recover a running thread on another account. Background jobs retain their assigned environments.
