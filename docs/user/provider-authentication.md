# Provider authentication

Pathway checks whether the provider selected for a thread is signed in. If a Claude or Codex session expires, a sign-in banner appears above the conversation.

For Claude, select **Sign in** to open Claude's authorization page. After approving access, copy the authorization code shown by Claude, return to Pathway, paste the code into the banner, and select **Connect**.

For Codex, select **Sign in** to open the OpenAI device sign-in page. Enter the one-time code shown in the Pathway banner, complete the OpenAI sign-in, return to Pathway, and select **I've signed in**. Device-code authentication must be enabled for the OpenAI account or workspace.

Pathway refreshes the provider automatically when sign-in succeeds.

The authorization page opens on the device running the Pathway client, while the resulting credentials stay on the environment that runs Claude. This also works when controlling an environment remotely.

Select **Cancel** to discard an unfinished sign-in. Unfinished Pathway sign-in flows expire after ten minutes.
