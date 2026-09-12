# Background services

An agent can finish its reply while a command continues running, such as a development server. The thread shows **Waiting** until its background work finishes.

Open the thread's action panel and look below **Usage** for **Background services**. Each task starts as a compact, single-line row. Use the chevron beside **Stop** to expand or collapse it. Expanded rows show the full command and status. Choose **Open output** from an expanded command to read its output in a separate, resizable side panel. Output stays out of the action palette; close its tab when finished.

For Codex background commands, choose **Stop** to terminate that command individually. The completed conversation stays intact, and stopping a command does not trigger an automatic follow-up. The status changes to **Stopping** while the request is processed. Once stopped, the command leaves the pending list. If stopping fails, the task stays listed with an error and can be retried.

Individual stopping is currently available for Codex commands whose terminal is still tracked by the connected provider session. Other task types remain visible, with Stop unavailable. After a provider session restarts, a previously reported command may no longer be attached and cannot be stopped through this control.

Provider background commands expose captured output rather than an interactive terminal. For interactive terminal sessions, use the **Terminals** section to open or kill the session.

You can hide or reorder Background services in the action palette settings. The panel works in web and desktop clients, including when connected to a remote environment.
