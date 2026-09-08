# Browser work and agent questions

## Questions while work continues

Some Codex models can ask a question while continuing their work. A **Question** button appears inline in the web and desktop conversation for each pending request. Hover over it to preview the questions. Click it to show the question and its options in a panel attached above the message composer. Use the composer to write your own answer, or leave it blank to use the selected option, then submit. Close the panel to return to your message draft. New questions do not open the panel or move your typing focus.

Open the button to review a question group. A suggested answer can be selected initially, but nothing is sent until you submit. You can write your own answer. Closing the panel keeps the question and your answer draft available. Submit the complete group together.

In web, desktop, and iOS conversations, submitted replies show each question above your answer in the message bubble. This also applies when viewing earlier replies. Copy includes the questions and answers. Submitted question replies cannot be opened in the message editor.

Pending questions survive reconnects. An answer sent after the agent finishes starts a follow-up in the same task. If a question came from a subagent, its answer returns to that conversation. If delivery fails, the question becomes available for retry.

Blocking questions still pause the agent and use their existing response flow. Other providers keep the question features their runtimes support.

## Choose a browser

The environment browser runs beside your agent. You can view it from the web app or iOS without keeping Pathway desktop connected. Its tabs and website sessions stay on that environment when your client disconnects.

On desktop, the browser panel lets you choose between This desktop and Environment browser. They have separate website sessions. A task keeps its browser host while it works. Wait for an action to finish before switching hosts.

Use the tab bar to open, select, and close pages. Websites can open additional tabs for links and sign-in flows. Closing the final environment-browser tab stops its browser process. Opening the browser later reuses the task's saved website profile.

Take browser control before interacting while the agent is working. Resume the agent when you are finished.

## Saved logins

Settings → General → Passwords stores website logins in your Pathway account. On iOS, open Passwords from the browser to manage saved logins. The vault uses encryption on Pathway's servers and synchronizes through your account.

The browser's Saved logins picker lists accounts for the current website. Select an account and fill it, then submit the website's sign-in form when ready. Filling does not put the password in the conversation. Browser tools can inspect the page, so only fill accounts you intend the task to use.

You can replace or delete a saved login. Passkey private keys remain with their authenticator; the password vault does not store them. Apple Passwords and iCloud-synced passkeys are not yet connected to this vault. Supported signed macOS builds can offer device-bound Touch ID credentials separately.

## Screenshots and recordings

Capture a screenshot or record the selected tab. Environment recordings are silent MP4 files. They stop after ten minutes or about 500 MiB; desktop recordings stop after ten minutes or about 100 MiB. Completed captures appear in the browser panel or in a saved-recording notification.

Each task keeps up to 50 recent environment-browser captures, totaling at most 1 GiB. The oldest capture files are removed when either limit would be exceeded. Deleting the task removes its environment-browser captures. Download any copies you want to keep.

Your environment needs Chromium for browser work and full FFmpeg for MP4 recording. If either is missing, Pathway shows a setup message. A recording follows its selected tab; changing tabs does not change what is being recorded.
