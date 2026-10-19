# Updating a remote environment

When a connected environment needs an update, the bar above the message composer offers **Update**. You can also update it from Connections settings.

For a compatible desktop host, confirm the update to let Pathway check its configured release channel, download the update, and restart the desktop app on that machine. Restarting briefly disconnects everyone using that host, including its local desktop windows.

The same bar shows a spinner and the current step: **Checking for updates…**, **Downloading update…**, **Installing update…**, then **Reconnecting…**. It clears after Pathway reconnects and verifies the installed version. If the update fails, the bar shows the reason and offers **Retry update**. If installation fails before the app quits, Pathway keeps its windows open and attempts to restart its stopped servers.

Older desktop hosts show instructions to update the app on that machine. Update them locally once to enable remote updates in subsequent releases. Development builds and installations without an available automatic update feed cannot install a desktop update this way.

Background-service environments continue to use their server update flow. Environments that cannot update remotely offer a command to run on the host.

Remote update controls are available in the web and desktop clients. The native iOS app does not currently offer these controls.
