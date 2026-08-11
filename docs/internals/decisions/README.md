# Architecture decision records

> For maintainers. Using Pathway? See [docs/user](../../user/).

One file per decision. A record states the context that forced a choice, the choice, and what
it costs. Records are append-only: when a decision is reversed, add a new record and mark the
old one superseded rather than editing history.

Status values: `Proposed`, `Accepted`, `Superseded by NNNN`.

| #                                               | Title                                    | Status   |
| ----------------------------------------------- | ---------------------------------------- | -------- |
| [0001](0001-mandatory-account-gate.md)          | Accounts are required to open the app    | Accepted |
| [0002](0002-first-party-auth-forms.md)          | First-party sign-in and registration UI  | Accepted |
| [0003](0003-profile-in-clerk-user.md)           | User profile lives on the Clerk user     | Accepted |
| [0004](0004-onboarding-stepper.md)              | Blocking, resumable onboarding stepper   | Accepted |
| [0005](0005-company-via-clerk-organizations.md) | Company modelled as a Clerk organization | Accepted |
