# Thread lifecycle preserves policy until deletion

Snoozed threads remain eligible for alerts because snoozing changes sidebar organization rather than
thread execution. Settled and archived threads retain their Alert Policy overrides but do not deliver
alerts until reopened. Deleting a thread removes its override. Existing Notification Tray records
continue through their normal retention period instead of disappearing with the thread setting.
