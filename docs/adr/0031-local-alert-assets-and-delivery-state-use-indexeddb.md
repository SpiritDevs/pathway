# Local alert assets and delivery state use IndexedDB

Uploaded sounds and per-installation delivery state belong to one browser or desktop installation.
They do not sync through Pathway Cloud.

Web and desktop renderers store custom audio bytes, the installation cursor, handled event ids, and
pending quiet-hours state in a versioned IndexedDB database. `ClientSettings` stores only the selected
sound identifier, asset metadata, delivery switches, and quiet-hours schedule.

This keeps multi-megabyte audio out of browser `localStorage` and Electron's JSON settings file while
using one storage contract on both first-release clients.
