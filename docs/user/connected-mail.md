# Connected mail

Mail connects a Gmail account to your signed-in Pathway workspace. Your mailbox is private to you. Other workspace members, including administrators, cannot read it through Pathway.

Open Email and choose Mail. Connect Gmail from Email settings in the signed-in Pathway web app. Desktop and native apps provide a link to web setup, then use the connected account. Bring-your-own Google OAuth credentials are supported first; a Pathway-managed connection is available when your relay operator has configured it. The connection page shows the callback address to register with Google. You may need to reconnect when Google authorization expires.

Mail keeps arriving while your environments are offline. The initial import covers the last twelve months, excluding Spam and Trash. Synced attachments and message bodies are available from your other devices through the same account. Very large messages and attachments may remain available only in Gmail; the reader identifies incomplete content. Attachments over 5 MiB are not copied into Pathway.

## Analysis and briefings

In the mailbox settings, choose a primary environment and a provider instance and model. You can choose a backup environment with its own provider instance. Codex, Claude and OpenCode support mail analysis. The selected environment uses your provider access to process mail.

Every message has a Priority or Noise bucket and a reason. Messages waiting for analysis say so. Priority messages receive a briefing. If both environments are unavailable, mail continues to arrive and analysis waits. A failed analysis can be retried after checking the environment and model settings. Analysis uses bounded message text; it does not read attachments, and large messages may be analyzed from an excerpt.

Moving a message from Noise to Priority requests a briefing and remembers your choice for that sender. Moving it back to Noise updates the sender rule. A manual correction takes precedence over analysis already in progress.

## Reading and replying

Select an account or view mail across your accounts. Priority, Noise and All provide separate views. Messages in the same conversation are linked from the reader. Remote images and styles are blocked until you choose to load them for that message.

Reply yourself or request an AI draft. Review the recipients and content before pressing Send. Saving or generating a draft never sends it. Drafts show their delivery status. If delivery cannot be confirmed, check Gmail Sent before composing another copy.

Use Discard draft to remove an unsent draft you no longer need. Submitted messages and uncertain deliveries remain visible so you can check their status.

Sender knowledge stays private with your mailbox. Save contact adds the sender's name and address to the selected workspace's shared contact directory after confirmation. It does not copy private sender notes.

## Disconnecting

Disconnect removes Pathway's copy of the mailbox and schedules removal of its private stored files and Google authorization. It does not delete your messages from Gmail. Reconnecting starts a fresh import.

SMTP capture remains available separately for development email.
