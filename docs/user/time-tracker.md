# Time Tracker

Your timers and completed sessions belong to your account and sync across devices. You can run one manual timer alongside any number of automatically tracked agent sessions. Stopping a manual timer records its duration; deleting a completed session removes it from history and totals. Web and desktop history show durations as hours, minutes, and seconds (`HH:MM:SS`).

Agent work is tracked automatically on registered environments with linked projects. Each independent thread run records its own time, including concurrent runs on the same project. Tracking pauses when the agent is blocked waiting for permission or an answer and resumes when work continues. A question that lets the agent keep working does not pause tracking. Closing the app does not stop an agent's timer.

Automatic agent sessions belong to the account of the person who registered the environment. On shared environments, this is not a separate record of each person's working hours. Tracking starts with new runs after the environment receives the updated tracker; earlier runs are not backfilled.

Successfully creating a task records at least one minute. If you actively compose it for longer, that active time is recorded instead. After 30 seconds without interaction, composition stops adding time until you interact again. Leaving the app pauses composition immediately. Cancelled drafts and failed creations add no time. Creating a subtask follows the same rule.

The clock beside your profile appears only while at least one timer is running on web and desktop. It opens the active timers, grouped by project, and shows whether each agent is working or paused. Open Time Tracker from the sidebar for manual controls, analytics, and history, even when no timers are running. On Apple clients, the native Time Tracker includes the active agent list and analytics.

Analytics separates combined work from elapsed activity. Eight agents working simultaneously for 30 minutes add four hours of combined work and 30 minutes of elapsed activity. Manual work and task creation appear separately from agent work. A task's one-minute minimum does not invent an extra minute of elapsed activity.

Use the period and project filters to review daily trends and project totals. Synced projects combine work from their linked environments. If an environment loses its connection, its displayed timer stops advancing after a short grace period and shows that it is waiting for a connection. Recorded work syncs when the environment reconnects.

History loads 50 sessions at a time. Choose **Load more sessions** to see earlier entries. Today and This Week totals include the full selected period, regardless of how many history pages you have loaded. On Apple clients, **All sessions** shows a **Loaded sessions total**, which grows as you load more history.

The latest sessions and period totals update automatically. Refresh history to reload older entries after changes on another device: pull down on Apple clients or choose **Refresh history** on desktop after loading more entries.

If a reporting period exceeds the 2,000-session reporting limit, analytics marks totals as unavailable. Choose a shorter period. Every completed session remains accessible through history; a partial total is never presented as the full period total.

Completed agent runs receive a specific title and a short description of their recorded actions and results. Summaries are generated in the background after tracking ends; recorded durations do not wait for generation. If a summary cannot be generated, the entry explains this and retains its time. In web and desktop history, choose the thread link to open the source conversation.

Choose **Settings → Time Tracker → Summary model** to select the model on your primary environment. Each environment uses its own setting, so configure other environments by making them primary first. Codex, Claude, and OpenCode support this text-only task. Manual timers have separate title and description fields. Task creation entries identify the task and describe the creation activity. Older entries retain their existing text.
