# Retry a failed message

If setup fails before the agent starts, the run stops and shows the error in the conversation.
You can address the reported problem and send the request again.

When the latest message you sent fails, Pathway may show **Retry message** beneath it. Select the
button to send the same text and attachments again without rebuilding the prompt in the composer.

Retry replaces the failed attempt and starts the message again from the state immediately before
that attempt. The action appears only when Pathway can restart safely. It is not offered for older
messages, messages sent by another agent, or attempts that changed files.

If **Retry message** is unavailable, resolve the reported provider or connection problem and send
the prompt again from the composer.
