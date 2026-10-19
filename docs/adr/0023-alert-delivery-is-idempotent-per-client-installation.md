# Alert delivery is idempotent per client installation

Each client installation delivers an Attention Event at most once. Tabs in one browser installation
coordinate so one tab owns delivery. Reconnects and replayed Convex data do not produce another alert
for an event the installation has handled. Desktop, separate browser installations, and separate
devices remain independent and may each deliver the event according to their local settings.
