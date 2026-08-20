# Companies and permissions

> For maintainers. Using Pathway? See [docs/user](../user/).

Convex owns companies, memberships, teams, roles, invitations, and every authorization-bearing
relationship. Clerk proves user identity but does not decide company membership or permissions. The
decision is recorded in [0007](./decisions/0007-convex-company-local-first-sync.md), and replica
behavior is documented in [cloud-sync.md](./cloud-sync.md).

## Tenancy model

A company is the tenancy boundary. Every cloud project, issue, workflow, integration, environment
registration, and sync version belongs to exactly one company. A user may hold memberships in any
number of companies and may join any number of teams in each.

The first successful sign-in creates an ordinary one-member tenant with
`workspaceKind: "personal"`. Choosing Company during onboarding, or upgrading later from
**Members & Teams**, changes that same tenant to `"organization"`. It can then be renamed, add
teams, and invite members.

This discriminator changes product presentation and which collaboration administration actions
are offered; it does not create a second storage or authorization model. Personal workspaces still
have their founding membership, ownership grant, and seeded roles because attribution, sync, and
environment service identities depend on them. Projects, issues, environments, integrations, and
the sync feed follow the same company id in both modes.

The authoritative entities are:

| Entity               | Purpose                                                                            |
| -------------------- | ---------------------------------------------------------------------------------- |
| `users`              | Clerk subject, normalized verified email, display profile, and timestamps.         |
| `companies`          | Tenant identity, lifecycle, issue-key counter, authorization epoch, and sync head. |
| `memberships`        | One user's `active`, `locked`, or `left` relationship to one company.              |
| `companyOwners`      | Ownership links separate from role assignments.                                    |
| `teams`              | Company-owned visibility and workflow scopes.                                      |
| `teamMemberships`    | Many-to-many membership and team assignments.                                      |
| `roles`              | Company-owned editable names and permission bundles.                               |
| `roleAssignments`    | A membership/role assignment scoped to the company or one team.                    |
| `companyInvitations` | Email-bound, expiring, single-use invitation state and intended assignments.       |
| `companySettings`    | Offline-access duration and other company policy.                                  |

Company deletion disables normal access immediately. Owners may restore it for 30 days. After that
window, the purge removes company records, files, invitations, credentials, and sync-feed data.

## Owners and roles

Ownership is not a role. It is non-editable, stored separately, and implicitly passes every
authorization check. A company may have several owners.

Any owner may add or remove another owner, schedule deletion, or restore the company. A transaction
must reject removal, lockout, or departure that would leave no owner. The last-owner invariant is
checked against the resulting active ownership set rather than through UI gating.

`Admin`, `Manager`, and `Member` are seeded as editable roles. Their names and switches may change;
their initial contents are product defaults, not special cases in authorization. Deleting or
editing a role never changes the owner set.

## Permission switches

Roles contain allow-only switches for:

- company read and manage;
- members read, invite, and manage;
- teams read and manage;
- roles read and manage;
- billing read and manage;
- projects read and manage;
- issues read, create, update, and delete;
- workflow configuration;
- comments create, update own, and moderate;
- shared views;
- automation run and manage;
- integrations read and manage;
- environments read and manage;
- remote agents dispatch and control;
- audit read;
- data export.

Billing switches exist before Stripe, plans, invoices, or billing screens. They reserve stable
authorization vocabulary and grant no unimplemented billing capability.

## Effective authorization

Role assignments are scoped either to the whole company or to one team. Effective permissions are
the OR-union of every assignment applicable to the record and requested action. There are no deny
rules or role-order precedence.

For a company-wide record, only company-scoped assignments apply. For a team-visible record, an
assignment applies when it is company-scoped or scoped to a team through which the actor can access
that record. A role in one team never grants access through a different team.

Company-administration permissions remain company-scoped even if a team role contains the switch.
For example, `members.manage`, `roles.manage`, or company deletion does not gain company-wide effect
from a team assignment. Owners remain the explicit bypass.

Every issue belongs to one company and is visible to zero or more teams:

- no teams means company-wide visibility;
- one or more teams means any attached team with an applicable `issues.read` grant exposes the
  complete issue;
- access through a team includes comments, attachments, relations, and history;
- editing applies the same union rule with the requested write switch; and
- adding or removing team visibility requires scope-management authority for the affected team.

Removing a team must atomically clear or reassign team-scoped labels, cycles, workflow ownership,
and project references that would otherwise become invalid. An issue has one workflow owner even
when several teams can see it.

### Team lifecycle and assignment batches

Archiving a team retires it from new member and role assignments; it is not deletion. Existing
work, team memberships, role assignments, and effective access remain unchanged. Restore clears
the archive marker and makes the same team available for new assignments again. Archive and restore
emit team upserts but do not increment the authorization epoch.

Administration can reconcile team members, one membership's teams, or one membership's
company-scoped roles with atomic add/remove deltas. Each mutation validates the complete request
before any write, emits all effective upserts and tombstones through one feed append, and increments
the authorization epoch once when anything changed. Existing additions and absent removals are
no-ops. Effective batches are capped at 500 changes; clients narrow local search or filters before
submitting a larger selection.

The settings UI searches and virtualizes the already-replicated company directory. It does not page
assignment options from Convex or issue extra list queries.

Authorization changes increment the company authorization epoch. Backend queries and mutations
always check current authority; the epoch additionally tells local replicas that previously cached
visibility can no longer be trusted. See [cloud-sync.md](./cloud-sync.md#cursors-and-authorization-epochs).

## Invitations

Invitations are Convex records delivered through Resend. Administration requires an online client
with `members.invite` and the authority to assign every intended team and role.

The flow is:

1. Normalize the invitee email and create an invitation containing the intended team and role
   assignments, inviter, expiry, and delivery state.
2. Generate a cryptographically random token. Store only its SHA-256 hash; the plaintext exists
   only in the link sent to the invitee.
3. Send a seven-day link from a Convex Node action. Use
   `company-invite/<invite-id>/<delivery-attempt>` as the Resend idempotency key so retrying one
   attempt cannot deliver duplicates.
4. Preserve the invitation token through Clerk sign-in or registration.
5. Require the signed-in user's verified normalized email to equal the invitation email.
6. In one transaction, create or reactivate the membership, apply the intended team and role
   assignments, consume the token, and increment the authorization epoch.

Acceptance is single-use and email-bound. Existing and new Clerk users follow the same acceptance
transaction. Resend creates a new delivery attempt and idempotency key without changing the token's
single-use semantics. Revocation and expiry prevent acceptance; neither deletes the audit record.

Invitation functions never use Clerk Organizations, `unsafeMetadata`, or an active Clerk
organization as an authorization source. Clerk supplies the verified subject and email that Convex
matches to its own user and invitation records.

## Service identities

An environment may register with several companies. Each registration has independent service roles
and team scopes. The relay exchanges the environment's DPoP-bound credential for a short-lived
`aud=pathway-convex` service JWT, but the token does not contain self-asserted company authority.
Convex resolves the registration and applicable permissions from current records.

Environment discovery and cross-machine agent control add on-behalf-of authorization beyond this
service identity. An environment registration alone never grants the human or agent action; see
[0008](./decisions/0008-cross-environment-agent-control.md). The underlying relay and environment
credential boundaries remain documented in [environment-auth.md](./environment-auth.md) and
[remote.md](./remote.md).
