# Architecture decision records

> For maintainers. Using Pathway? See [docs/user](../../user/).

One file per decision. A record states the context that forced a choice, the choice, and what
it costs. Records are append-only: when a decision is reversed, add a new record and mark the
old one superseded rather than editing history.

Status values: `Proposed`, `Accepted`, `Superseded by NNNN`.

| #                                                           | Title                                                    | Status             |
| ----------------------------------------------------------- | -------------------------------------------------------- | ------------------ |
| [0001](0001-mandatory-account-gate.md)                      | Accounts are required to open the app                    | Accepted           |
| [0002](0002-first-party-auth-forms.md)                      | First-party sign-in and registration UI                  | Accepted           |
| [0003](0003-profile-in-clerk-user.md)                       | User profile lives on the Clerk user                     | Accepted           |
| [0004](0004-onboarding-stepper.md)                          | Blocking, resumable onboarding stepper                   | Accepted           |
| [0005](0005-company-via-clerk-organizations.md)             | Company modelled as a Clerk organization                 | Superseded by 0007 |
| [0006](0006-issue-tracker.md)                               | Issue tracker on /issues                                 | Accepted           |
| [0007](0007-convex-company-local-first-sync.md)             | Convex company authority and local-first issue sync      | Accepted           |
| [0008](0008-cross-environment-agent-control.md)             | Cross-environment agent control                          | Accepted           |
| [0009](0009-convex-relay-persistence.md)                    | Convex relay persistence                                 | Accepted           |
| [0010](0010-company-integrations-and-durable-automation.md) | Company integrations and durable automation              | Accepted           |
| [0011](0011-company-owned-projects.md)                      | Company-owned projects and permanent personal workspaces | Accepted           |
