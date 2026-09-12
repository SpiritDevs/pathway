# Starting agent work on another environment

An agent can start a thread on another environment connected to your company and project. The request is queued through Pathway Cloud, so the two computers do not need a direct connection. Queued agent requests expire after one hour if the destination has not picked them up. A queued request means delivery is pending; it does not mean the thread is already running.

The source environment needs a service role with **Dispatch remote agents**. Starting a new thread uses that permission. Sending messages to an existing thread or interrupting it also requires **Control remote agents**. Registering an environment does not give its agents your personal permissions.

Both environments must be actively registered, and the member who registered the source environment must still be active. The activity record identifies the source environment and retains the registering member for attribution. Permission failures explain which permission or registration needs attention.
