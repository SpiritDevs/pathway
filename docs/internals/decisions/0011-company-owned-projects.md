# 0011 — Company-owned projects and permanent personal workspaces

Status: Accepted
Date: 2026-08-19

## Context

[0007](0007-convex-company-local-first-sync.md) made Convex authoritative for cloud projects and
established that every synchronized record belongs to one company. The contracts followed: a cloud
project carries no `environmentId` and no `workspaceRoot`, and
[cloudProject.ts](../../../packages/contracts/src/cloudProject.ts) states that a project with no
binding is still a real project you can file issues against.

The implementation did not follow. In practice a project could only come into existence through
`cloudProjects.ensureEnvironmentProject`, which refuses unless a registered environment is
supplied, and which reuses the environment-local project id as the cloud id. The Projects workspace
was derived entirely from environment snapshots — `SidebarProjectSnapshot extends EnvironmentProject`
— so a project with no checkout could not be listed, selected, or opened. A project therefore
existed only where its files did, which is the opposite of what 0007 decided.

Two consequences followed from that gap. Users could not plan a project before cloning it anywhere.
And an environment-local checkout that had never been registered was invisible to every
company-scoped surface while remaining fully visible in the sidebar, which read as the app losing
track of projects it was plainly displaying.

Separately, 0007 stated that "personal use is not a separate tenancy model", and the implementation
enforced that by _converting_ a member's personal workspace into an organization the first time
they created a company. That is a lossy, one-way operation on the one place a member keeps work
that is only theirs.

## Decision

A project is owned by a company and exists independently of any machine. An environment checkout is
an attachment: zero, one, or many, added and removed freely, and never part of the project's
identity.

- `cloudProjects.createCompanyProject` creates a project with no binding and a freshly minted
  domain id. `ensureEnvironmentProject` remains the attach path but is no longer the only creator,
  which breaks the cloud-id-equals-local-project-id coupling.
- The Projects workspace lists logical projects merged from the company's project list and the
  local checkouts, so a project with no checkout is as visible and selectable as one with three.
  Anything that cannot run agents says so rather than disappearing.
- A project with no company is surfaced and resolved, not hidden. Launch asks which company owns
  each unassigned checkout and blocks until every one has an answer.
- Deletion follows the same ownership boundary. `cloudProjects.deleteCompanyProject` tombstones the
  company project and revokes all checkout bindings without contacting their environments. An
  offline environment consumes that durable revocation when it reconnects, then deletes its local
  project and threads while leaving the directory on disk untouched. Its outbound publisher may
  never resurrect the tombstoned project.

**A personal workspace is permanent.** Every member has one, it is never converted into an
organization, and creating a company adds a second workspace alongside it. This amends the tenancy
statement in [0007](0007-convex-company-local-first-sync.md): personal is still an ordinary
one-member company using the same storage and authorization model, but it is now a _durable_
one that a member keeps for side projects and anything not work. `companies.upgradeToOrganization`
is replaced by `companies.createOrganizationWorkspace`.

### Moving a project between companies

A project may move, and its issues move with it. Because issue statuses, labels, and keys are all
company-owned, the move is a migration rather than a field update, and it is driven by an explicit
stepper so the lossy parts are chosen rather than guessed:

- **Statuses** are mapped source-to-target. Candidates are pre-matched on exact name, then
  case-insensitively, then on a normalised comparison; every source status must be mapped before
  the move proceeds.
- **Labels** are mapped the same way, and an unmatched label may be created in the destination or
  dropped.
- **Milestones** move with the project rather than being remapped, because `IssueMilestone.projectId`
  is required.
- **Environment bindings, agent-thread metadata, captured email, and issue child records** move
  with the project. Child records include todos, comments, attachments, audit events, thread links,
  and relations whose two issues both move.
- **Issue keys are re-issued** under the destination company's prefix. This is destructive to any
  key a user has quoted or linked, so the review step states it plainly before anything is written.
- **Cycles do not travel.** A cycle spans a whole company rather than one project, so a moved issue
  leaves its cycle behind rather than pointing at one the destination does not have. Team visibility
  resets for the same reason: issues arrive company-wide instead of inventing a team nobody chose.
- **Company-local operations do not cross the boundary.** Active automation jobs are canceled as
  they move, Slack provenance is cleared, and Slack channel watches stay with their source
  integration while detaching from the project.

The move runs as one Convex transaction (`projectMigration.moveProjectToCompany`) and refuses
before writing anything if a status it was not told how to translate is in use. Both companies'
feeds are appended: tombstones in the source, upserts in the destination, because a replica told
only one side keeps serving work that has left.

## Consequences

- A project with no environment binding cannot start work. That is a designed, non-error state:
  automation already blocks visibly with `project-binding-missing` rather than failing, per
  [0010](0010-company-integrations-and-durable-automation.md).
- Removing a company project is available while every checkout is offline. Connected checkouts
  reconcile immediately; disconnected checkouts reconcile the next time their company replica
  syncs.
- A personal workspace can never add owners or administer memberships, and there is no longer an
  upgrade door that unlocks those. Collaborating means creating an organization alongside.
- Accounts provisioned before this decision may have had their personal workspace converted away.
  `provisionCurrentUser` recreates one for them, which silently adds a workspace to their switcher.
- Every consumer of `SidebarProjectSnapshot` must tolerate a project with no environment. The
  merge lives in one place, `components/projects/workspaceProjects.logic.ts`, and reuses the
  identity rules `buildIssueProjectOptions` already applies for the issue rail, so the two cannot
  disagree about which ids are the same project.
- Re-keying issues on a move is not reversible. The migration is per-project and transactional, but
  a user who moves a project back does not get the original keys.
