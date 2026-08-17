# Captured email across environments

Local SMTP capture still happens on the environment running the listener. When that environment is
linked to a company, Pathway synchronizes the parsed message into the company replica so the same
mail appears on your other environments.

The Email sidebar can show all environments or filter the inbox to one source. Every message row
and the open message identify the environment that accepted it. Project inboxes use the shared
company project identity, so mail captured in two different checkouts of the same project appears
together.

The synchronized record includes headers, text and HTML bodies, delivery analysis, the SMTP
transaction, and attachment names and metadata. Raw `.eml` source and attachment bytes remain on
the source environment. Messages too large for a safe Convex record also remain on their source
environment.

Read and unread changes are sent to the source environment and then synchronize back through the
company replica. If that environment is offline, its message remains readable from the replica but
the read-state action becomes available again when the source reconnects.

Email tags are shared by the company. Create a tag with a name and colour from any message action,
apply it to one or many messages, and use the Tags section in the Email sidebar to filter the
current inbox. Tags appear on both message rows and the open message.

Remote images and styles stay blocked until you choose **Load remote content**. That action also
trusts the message's exact From address, so future messages from that address load remote content
automatically on every environment in the company. Review or remove addresses under Settings →
Capture → Trusted senders. Trust applies to one address, not its whole domain; scripts, frames,
objects, and form submissions remain blocked even for trusted senders.

Deleting a message removes it from every synchronized view and records the delete until its source
environment reconnects. The source then removes its local database row, raw `.eml` file, and
attachment files, so an offline copy cannot reappear later.
