# Internal project workspaces

## Work order

- Name-only projects use a persistent, server-owned working directory under that environment's
  userdata/project-workspaces directory, keyed by project ID. Never create folders in the user's
  home directory for this flow.
- Distinguish the internal workspace from an attached directory in persisted project state and
  client contracts. The effective workspace remains available to agents.
- Without an attached directory, show No directory attached and Attach directory. Hide Git and
  worktree controls for the internal workspace.
- Attaching a directory preserves the project and threads. Offer to copy internal working files
  without overwriting destination files, or keep those files in internal storage.
- Show the attached directory and retained internal workspace stacked in the Workspace panel.
  Allow disconnecting the internal workspace only after an external directory is attached.
  Disconnecting never deletes its files. Connected internal files remain available to agents.
- Refuse directory switches while agent work is active. Preserve source files and never clean up
  internal working files on application restart.
- Existing home-directory workspaces require verified provenance before migration. Do not infer
  Pathway ownership from a directory name alone or move arbitrary user folders.
- Cover local and remote environments, web and desktop, and shared wire compatibility. Verify
  focused persistence, attachment, and UI behavior before considering the work complete.
