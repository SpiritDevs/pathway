# Quiet hours collapse suppressed alerts into one summary

Each client can schedule quiet hours by weekday and local start and end time. During that window the
client suppresses sound and OS notifications, while the Notification Tray continues to record every
Attention Event. When quiet hours end, the client groups subscribed events that remain unread by
thread and sends one summary. The summary uses one OS notification when enabled and plays the selected
sound once when enabled. Selecting it opens the Notification Tray. Events reviewed during quiet hours
do not appear in the summary, and Pathway never replays each suppressed alert separately.
