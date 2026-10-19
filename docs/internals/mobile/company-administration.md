# Native company administration

`PathwayCompanyAdministrationView` accepts companies, a cloud query/mutation/action request closure and a company-scoped replica entity reader. It includes company creation/rename/offline policy/deletion recovery; members with lock/unlock, removal, ownership and scoped role assignments; teams and memberships; role definitions and permission switches; invitation creation, resend and revocation.

Environment settings and company administration remain distinct. The company model always overwrites mutation `companyId` with its selected company. Company-level permission guards union only company-scoped grants for the signed-in membership; team assignments do not grant company administration. Unknown role data keeps management controls disabled. Ownership and membership mutations still rely on authoritative online backend checks, including last-active-owner protection. Administration does not enqueue writes offline.

The invitation action sends an email only after the user confirms the named recipient in the client. The native implementation never reads or stores invitation tokens. Revoked or accepted invitations cannot be resent; the one-minute backend resend cooldown is reflected in the UI.

Archived teams remain visible and editable by authorized administrators. Both native and desktop expose archive and restore through the company-authorized `teams:archive` and `teams:restore` mutations. Restore preserves membership and bumps authorization epochs. A departed member returns by invitation rather than an invalid state update. Removing a role cascades its assignments through the backend's existing bounded operation.

Focused tests cover team/company scope isolation, missing-role uncertainty, last-active-owner safeguards and selected-company mutation scoping. Parsing passed; platform compilation, live authorization-epoch updates, invitation delivery and visual/accessibility verification are separate integration checks.
