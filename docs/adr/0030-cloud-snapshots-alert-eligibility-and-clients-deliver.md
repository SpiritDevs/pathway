# Cloud snapshots alert eligibility and clients deliver

Thread alert policy belongs in Pathway Cloud beside the existing Attention Event history. Device
permission, sound, window focus, quiet hours, and installation idempotency are local concerns.

Convex records whether each Attention Event was eligible when it was created, while retaining every
event in the Notification Tray. A client may deliver only when that snapshot is true and the current
policy still enables the event. The client then applies lifecycle, foreground, quiet-hours,
coalescing, and installation-cursor rules.

This prevents newly enabled policy from waking old events, lets later disabling cancel delayed
delivery, and keeps platform behavior out of the relay and provider adapters.
