# Desktop updates

Use **Check for Updates…** in the top application menu or Settings → About to check for desktop and provider updates. Connected environments check their installed providers too.

Pathway also checks for updates in the background every few minutes. It checks less often once an update is waiting, and backs off while the update server cannot be reached. Background checks run quietly. The sidebar shows progress only for a check you started or for a download. When an update is available, you can download it from the sidebar, then choose **Restart to update** once it is ready to install.

After restarting, the desktop window opens while Pathway starts your environment, restores its work state, and checks your account. Your workspace becomes available when those checks finish. Provider availability can continue refreshing afterward. An update that rebuilds stored work history, or the first start of a WSL environment, can take longer than an ordinary restart.

Supported provider CLI updates install in the background once that provider's sessions have closed and its background jobs have finished. Pathway keeps idle sessions open for reuse, normally for up to 30 minutes, so an update can wait after a turn finishes. Existing work continues before an update starts. New sessions use the updated version without restarting Pathway. Provider updates do not add a separate update or restart notice to the workspace.

Settings → Providers shows available updates, waiting or installation progress, and the result for each environment. You can retry an unsuccessful update there, or use the manual instructions for providers that cannot update automatically. Turning off provider update checks in Settings → General also disables automatic provider updates.
