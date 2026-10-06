# Browser work and agent questions

## Questions while work continues

Some Codex models can ask a question while continuing their work. A **Question** button appears inline in the web and desktop conversation for each pending request. Hover over it to preview the questions. Click it to show the question and its options in a panel attached above the message composer. Use the composer to write your own answer, or leave it blank to use the selected option, then submit. Close the panel to return to your message draft. New questions do not open the panel or move your typing focus.

Open the button to review a question group. A suggested answer can be selected initially, but nothing is sent until you submit. You can write your own answer. Closing the panel keeps the question and your answer draft available. Submit the complete group together.

Questions in the web and desktop panel support formatted paragraphs, lists, links, bold text, and code. Long questions scroll inside the panel so your answer box stays accessible.

In web, desktop, and iOS conversations, submitted replies show each question above your answer in the message bubble. This also applies when viewing earlier replies. Copy includes the questions and answers. Submitted question replies cannot be opened in the message editor.

Pending questions survive reconnects. An answer sent after the agent finishes starts a follow-up in the same task. If a question came from a subagent, its answer returns to that conversation. If delivery fails, the question becomes available for retry.

Blocking questions still pause the agent and use their existing response flow. Other providers keep the question features their runtimes support.

## Choose a browser

Every browser tab is either **remote** or **local**:

- The **remote** browser runs beside your agent on the thread's environment. There, `localhost` is the environment, so `localhost:3000` shows the dev server your agent started. You can watch and use it from desktop, the web app and iOS, including over Pathway Connect. Its tabs and website sessions stay on that environment when your client disconnects. Its tab shows a blue globe with the page's icon on the corner.
- The **local** browser is the desktop app's own browser. There, `localhost` is the computer you are using. Only the desktop app has one. Its tab shows just the page's icon and title.

Hover a browser tab to see the page's title, its site, whether it is remote or local, and where it runs, above a preview of the page. Remote previews are live; local previews are a snapshot taken when you hover.

In a local tab, the address bar shows just the site once you leave it. Click it to see and edit the full address. The sliders button at its left shows whether the connection is secure, and **Clear site data** signs you out of that site and reloads it.

When the thread's environment is another machine, the browser opens remote by default. When it is the machine the desktop app runs on, it opens local. The web app and iOS always use the remote browser. On desktop, choose either one from the **+** menu in the panel's tab bar. Both kinds of tab can sit side by side.

Servers listed under **Local servers** run on the environment, so they open in the remote browser unless the environment is this computer. If you type a `localhost` address into a local tab while the environment is another machine, Pathway offers to open it in the remote browser instead. You can still open it on this computer. On desktop, right-click a local tab and choose **Open in remote browser** to move its page across.

When an agent browses in the remote browser, a small live preview of its page floats over the conversation on desktop and web. On iOS it appears above the composer. Click the preview, or choose **Open in right panel**, to see the same page in the browser panel. If the connection drops, the preview and the panel reconnect on their own. Choose **Reconnect** if the connection still fails.

On iOS, you can also choose Remote browser from the thread's top-right menu. It opens on the page the agent is using, as a full navigation screen. Use Back to return to the conversation. Enter a website address or choose New tab to begin. Reconnect browser retries the connection if loading fails.

Use the tab bar to open, select, and close pages. Websites can open additional tabs for links and sign-in flows. Closing the final remote-browser tab stops its browser process. Opening the browser later reuses the task's saved website profile.

On desktop, web, and iOS, the remote browser streams at your display's resolution. A small label in the corner shows the frame rate and delay, or that the stream is reconnecting; on desktop and web, click it to reconnect sooner. The stream pauses while the panel or window is hidden, and on iOS while the app is in the background. On iOS, tap to click and drag to scroll the page. When several people watch the same tab, the largest window sets the page size. The small live previews never change the page size, so watching from one never shrinks the agent's page. When the connection is slow, the picture gets softer so the page keeps up.

The page's own prompts appear over the stream: alerts, confirmations, text prompts, leave-page warnings, drop-down menus, and file pickers. Files you pick are uploaded to the environment. Text you copy in the page is copied to your device. Files the page downloads are listed under **Downloads** in the corner, and **Save** fetches each one from the environment. On iOS, prompts appear as system alerts and sheets, file pickers open Files, and **Downloads** sits in the browser's bottom bar, where **Share** sends a saved file to the share sheet or Files. While the agent is working, iOS shows a note that the page is asking instead of the prompt; take control to answer it. If an answer does not go through, the note stays with **Answer** to try again. Prompts wait while the app is in the background. Copying page text to your device is not yet available on iOS.

The agent works in whichever browser you are watching. Opening the remote browser routes the agent's browsing there. On desktop, opening a new local tab hands the agent back to this computer's browser.

Take browser control before interacting while the agent is working. Use **Take over to assist agent** in the browser panel or above the composer. Resume the agent when you are finished. Any client watching the remote browser can take control. For a local tab, only the desktop showing that tab can take control. A failed attempt to open a browser without a tab does not offer takeover.

### Site information on macOS

In the local browser on a Mac with Apple silicon, click the sliders button at the left of the address bar to open the site information dropdown. It shows the site, its connection status, **Site settings** and **Clear site data**. Use the close button to return to the page.

Click the connection row to open **Security**. It explains the connection's security and shows connection details when available. A local HTTP page is labeled **Local server**. For HTTPS pages with a certificate, click **Certificate is valid** (or **Certificate is not valid**) to open the certificate viewer. Use the back arrow to return to site information.

The certificate viewer has **General** and **Details** tabs. General shows who the certificate was issued to and by, its validity period, and SHA-256 fingerprints for the certificate and public key. Details shows the certificate hierarchy; select a certificate to inspect its fields. Close the viewer to return to the browser.

**Site settings** opens a new tab beside the page. Review or change that site's permissions, such as camera, microphone and location. An explicit Allow or Block applies to that environment's local browser sessions; macOS can still ask for permission to use the device. Close the settings tab when finished and reload the site if needed. Site settings opens for websites, not blank tabs or browser settings pages.

**Clear site data** removes the site's stored data and reloads the page. It can sign you out and discard saved website state. Cookie clearing can also sign you out of related subdomains of the same site. Other environments' local browser sessions are unaffected, and this action keeps the site's permission settings. Change permissions separately in Site settings.

Website logins from earlier desktop versions may need to be entered again after the browser update. Your conversations and the passwords saved in your Pathway account remain available.

These certificate and Site settings controls belong to the macOS local browser. Windows and Linux show connection information and Clear site data. The remote browser, web app and iOS use their existing browser controls.

### Keyboard in the desktop browser

While you are using a page in a local tab, your keys go to that page, the way they would in any browser. Select all, copy, cut, paste, undo and redo work in its fields. Pathway's own shortcuts, such as Settings, Close Window and zoom, wait until you click back into the app or switch to another view. The menu bar items still work when you click them.

## Saved logins

Settings → General → Passwords stores website logins in your Pathway account. On iOS, open Passwords from the browser to manage saved logins. The vault uses encryption on Pathway's servers and synchronizes through your account.

You can replace or delete a saved login. Passkey private keys remain with their authenticator; the password vault does not store them. Apple Passwords and iCloud-synced passkeys are not yet connected to this vault. Supported signed macOS builds can offer device-bound Touch ID credentials separately.

## Screenshots and recordings

Capture a screenshot or record the selected tab. Environment recordings are silent MP4 files. They stop after ten minutes or about 500 MiB; desktop recordings stop after ten minutes or about 100 MiB. Completed captures appear in the browser panel or in a saved-recording notification.

Each task keeps up to 50 recent environment-browser captures, totaling at most 1 GiB. The oldest capture files are removed when either limit would be exceeded. Deleting the task removes its environment-browser captures. Download any copies you want to keep.

Your environment needs Chromium for browser work and full FFmpeg for MP4 recording. If either is missing, Pathway shows a setup message. A recording follows its selected tab; changing tabs does not change what is being recorded.
