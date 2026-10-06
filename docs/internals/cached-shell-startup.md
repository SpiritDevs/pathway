# Shell startup tracing

Two once-per-renderer performance marks and trace spans cover the visible shell:

- `web.startup.cachedShellPainted`: the ready shell contains cached or synchronizing environment snapshots.
- `web.startup.liveShellSynced`: all loaded snapshots are live; a mixed cached/live environment set still counts as cached.

Marks run on the second animation frame after the ready shell commits. They are a paint proxy, not browser Paint Timing entries. Spans run from `performance.timeOrigin` to the original mark time. Cached paint is buffered until authenticated tracing can export it, and exporter reconfiguration does not emit the milestone twice. Cold launches may only have the live mark; unavailable environments can prevent the live mark.

When both marks exist, their difference is the interval during which cached content was usable before live synchronization. Browser and desktop timings need a real-client measurement; unit tests verify ordering, not wall-clock improvement.
