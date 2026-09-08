# Balance new threads across machines

Auto balance chooses a connected machine with available CPU and memory when you start a new thread. It is off by default.

On web and desktop, open **Settings → Environments → Load balancing**. On iOS, open **Connections → Load balancing**. Enable **Auto balance new threads**, then choose a preference for each machine:

- **Prefer** gives the machine more weight when resources are available.
- **Normal** uses the standard weight.
- **Less often** reduces its weight.
- **Manual only** excludes it from automatic placement. You can still select it yourself.

These are preferences, not fixed percentages. They are saved separately on each client.

Machines must have active connections to the same project in the same company and an available provider. On web and desktop, the destination must support your selected provider, model, and options. On iOS, the first choice happens when you select a project; rechecking an existing selection preserves a compatible provider and model. Grouping unrelated projects together in the sidebar does not make them eligible.

The new-thread composer shows the selected environment. Choose **Auto** to check again, or select a machine to use it manually. If Auto cannot find an eligible destination, choose a machine explicitly before sending. A machine that is offline, too busy, or unable to report its resources can be unavailable for automatic placement.

Choosing an account or binding the draft to a workspace, branch, or attachments keeps it on that machine. A launch also keeps its destination when you retry after a connection error. Existing threads continue on their original environment.

Auto balance uses the providers configured on each machine. It does not combine subscription allowances or automatically recover a running thread on another account. Background jobs retain their assigned environments.
