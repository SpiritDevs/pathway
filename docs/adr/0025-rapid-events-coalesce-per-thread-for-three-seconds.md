# Rapid events coalesce per thread for three seconds

Each client coalesces eligible Attention Events from one thread for three seconds. The first event
posts an OS notification and plays one sound according to local delivery settings. Further events in
the window update that notification with the latest event and a count but do not play another sound.
The Notification Tray continues to store every Attention Event separately. Events from different
threads do not share a coalescing window.
