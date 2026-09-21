# Cloud synchronization

Pathway publishes project, thread, and captured-email changes as they happen.
It also checks periodically for changes that were missed during a disconnection.
While the owning environment is running and connected, these background checks
run every five minutes. Large repairs may need several passes.

A project assignment made on another device may appear during the next background
check. Editing the project's local details publishes those changes immediately.
