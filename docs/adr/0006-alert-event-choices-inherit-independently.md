# Alert event choices inherit independently

Completion, permission, user-input, and failure alert choices each resolve through the global ->
project -> thread cascade. The global scope stores an enabled or disabled value for each event.
Project and thread scopes store `inherit`, `enabled`, or `disabled` for each event. A normal thread
bell click is a bulk action. It enables every event when the effective state is mixed or disabled,
and disables every event when all are enabled. The advanced popup edits each event and can restore
all thread events to their project defaults. This model has no separate master flag that can
contradict the four event values.
