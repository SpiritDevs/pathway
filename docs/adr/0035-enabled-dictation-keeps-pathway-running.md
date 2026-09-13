# Enabled dictation keeps Pathway running

System-wide dictation remains available after the main Pathway window closes while dictation is enabled. Windows currently quits when its last window closes, so this feature deliberately adds a background lifetime with visible tray/menu-bar controls. Open Pathway, enable/disable, and Quit must remain reachable; explicit Quit stops dictation.

The background lifetime must preserve Pathway's authenticated account readiness and personal dictionary updates. It cannot restore a cached account identifier as proof of sign-in or depend on a renderer that closing the window has destroyed.
