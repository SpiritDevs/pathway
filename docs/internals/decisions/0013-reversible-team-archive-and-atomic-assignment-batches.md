# 0013 — Reversible team archive and atomic assignment batches

Status: Accepted
Date: 2026-08-20

## Context

Company assignment editors operate over a complete local replica, but their card grids rendered
every option and immediate bulk work would otherwise require one network mutation per row. Team
archive also needed a clear meaning: teams remain referenced by work and authorization records, so
treating archive as deletion or implicit revocation would destroy useful history and surprise
administrators.

## Decision

Team archive is reversible retirement, not deletion. Archiving sets `archivedAt`; restoring clears
it. Both operations emit an ordinary team upsert. Neither changes memberships, role assignments,
work references, or effective authorization, so neither bumps the authorization epoch.

Team-member, member-team, and company-role bulk changes are transactional deltas. The backend
validates every requested target before writing, applies only effective additions and removals,
appends the resulting changes through one company-feed operation, and bumps the authorization
epoch at most once. Existing additions and absent removals are idempotent no-ops.

Assignment search, filtering, counting, and virtualization run over the existing local company
replica. We intentionally do not add server pagination or extra list queries. `LegendList` limits
mounted rows while visible-result bulk actions still mean all locally filtered results, not only
mounted rows.

One effective delta is limited to 500 changes. The UI disables a bulk action above that boundary
and asks the administrator to narrow the search or filters.

## Consequences

- Archived teams retain their name, work, memberships, grants, and access behavior and can return
  to active assignment without reconstruction.
- Cleanup remains possible: existing inactive-member and archived-team assignments may be removed.
- A bulk action produces one transaction and at most one company-wide replica reseed.
- Large companies keep local, immediate search without mounting thousands of assignment rows.
