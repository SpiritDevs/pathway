# Asset deletion preserves message history

An asset and its attachments have separate lifecycles because the same file may be reused across threads and tasks. Removing an attachment does not delete the asset everywhere; deleting an asset moves it to 30-day Trash, revokes sharing, and leaves an Asset deleted placeholder in messages. Restoring preserves references to surviving contexts but does not reactivate old share links.

Deleting a thread moves its otherwise unreferenced assets to Trash unless Keep in Assets retains them independently. File replacement creates a new asset so historical messages do not silently change their evidence. Quota pressure never deletes assets automatically.
