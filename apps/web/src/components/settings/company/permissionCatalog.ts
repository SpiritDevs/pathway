/**
 * Human-readable presentation for every `CompanyPermission`.
 *
 * The role editor renders from this catalog rather than printing raw keys, so a switch that reads
 * `calendar.readAll` in the contract reads "See every shared calendar" to the admin toggling it.
 * The record is keyed by the contract's union, so a new permission fails to compile until it has a
 * label, a description, and a group.
 */
import { COMPANY_PERMISSIONS, type CompanyPermission } from "@spiritdevs/contracts/company";

export const PERMISSION_GROUPS = [
  "Company",
  "Members & teams",
  "Projects",
  "Calendar",
  "Issues",
  "Automation",
  "Environments",
] as const;

export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];

export interface PermissionPresentation {
  readonly group: PermissionGroup;
  readonly label: string;
  readonly description: string;
}

export const PERMISSION_CATALOG: Readonly<Record<CompanyPermission, PermissionPresentation>> = {
  "company.read": {
    group: "Company",
    label: "Read company",
    description: "See the company profile and its settings.",
  },
  "company.manage": {
    group: "Company",
    label: "Manage company",
    description:
      "Administer company settings, and manage sharing on any member's calendar as if you owned it.",
  },
  "billing.read": {
    group: "Company",
    label: "Read billing",
    description: "Reserved for billing. Nothing reads it yet.",
  },
  "billing.manage": {
    group: "Company",
    label: "Manage billing",
    description: "Reserved for billing. Nothing reads it yet.",
  },
  "audit.read": {
    group: "Company",
    label: "Read audit log",
    description: "Read the record of who changed what.",
  },
  "data.export": {
    group: "Company",
    label: "Export data",
    description: "Export company data out of Pathway.",
  },
  "members.read": {
    group: "Members & teams",
    label: "Read members",
    description: "See the member directory.",
  },
  "members.invite": {
    group: "Members & teams",
    label: "Invite members",
    description: "Send, resend, and revoke invitations.",
  },
  "members.manage": {
    group: "Members & teams",
    label: "Manage members",
    description: "Lock, unlock, and remove members.",
  },
  "teams.read": {
    group: "Members & teams",
    label: "Read teams",
    description: "See teams and who belongs to them.",
  },
  "teams.manage": {
    group: "Members & teams",
    label: "Manage teams",
    description: "Create, edit, archive teams, and change their membership.",
  },
  "roles.read": {
    group: "Members & teams",
    label: "Read roles",
    description: "See roles and the permissions they carry.",
  },
  "roles.manage": {
    group: "Members & teams",
    label: "Manage roles",
    description: "Create and edit roles, and assign them to members.",
  },
  "projects.read": {
    group: "Projects",
    label: "Read projects",
    description: "See company projects.",
  },
  "projects.manage": {
    group: "Projects",
    label: "Manage projects",
    description: "Create and edit company projects.",
  },
  "calendar.read": {
    group: "Calendar",
    label: "Use the calendar",
    description:
      "See your own calendars and any calendar shared with you by name. Every viewer needs this — a grant on its own is never enough.",
  },
  "calendar.readAll": {
    group: "Calendar",
    label: "See every shared calendar",
    description:
      "See team- and company-shared calendars in scope without a named grant. Private calendars, and events marked private, stay hidden.",
  },
  "issues.read": {
    group: "Issues",
    label: "Read issues",
    description: "See issues in scope.",
  },
  "issues.create": {
    group: "Issues",
    label: "Create issues",
    description: "Open new issues.",
  },
  "issues.update": {
    group: "Issues",
    label: "Update issues",
    description: "Edit issues, including their calendar links.",
  },
  "issues.delete": {
    group: "Issues",
    label: "Delete issues",
    description: "Delete issues.",
  },
  "workflow.manage": {
    group: "Issues",
    label: "Manage workflow",
    description: "Edit statuses, labels, and milestones.",
  },
  "comments.create": {
    group: "Issues",
    label: "Comment",
    description: "Write comments.",
  },
  "comments.updateOwn": {
    group: "Issues",
    label: "Edit own comments",
    description: "Edit and delete your own comments.",
  },
  "comments.moderate": {
    group: "Issues",
    label: "Moderate comments",
    description: "Edit and delete anyone's comments.",
  },
  "views.shared": {
    group: "Issues",
    label: "Manage shared views",
    description: "Create and edit views the whole company sees.",
  },
  "automation.run": {
    group: "Automation",
    label: "Run automations",
    description: "Trigger automations manually.",
  },
  "automation.manage": {
    group: "Automation",
    label: "Manage automations",
    description: "Configure automations and the rules that fire them.",
  },
  "integrations.read": {
    group: "Automation",
    label: "Read integrations",
    description: "See connected integrations and their health.",
  },
  "integrations.manage": {
    group: "Automation",
    label: "Manage integrations",
    description: "Connect, configure, and disconnect integrations.",
  },
  "environments.read": {
    group: "Environments",
    label: "Read environments",
    description: "See company environments and their status.",
  },
  "environments.manage": {
    group: "Environments",
    label: "Manage environments",
    description: "Register, rename, and remove company environments.",
  },
  "remoteAgents.dispatch": {
    group: "Environments",
    label: "Dispatch remote agents",
    description: "Start agent work on a company environment.",
  },
  "remoteAgents.control": {
    group: "Environments",
    label: "Control remote agents",
    description: "Steer, interrupt, and stop agent work on a company environment.",
  },
};

export function permissionPresentation(permission: CompanyPermission): PermissionPresentation {
  return PERMISSION_CATALOG[permission];
}

export interface PermissionGroupSection {
  readonly group: PermissionGroup;
  readonly permissions: ReadonlyArray<CompanyPermission>;
}

/**
 * Catalog groups in `PERMISSION_GROUPS` order, each holding its permissions in contract order.
 * Empty groups are dropped so the editor never renders a heading with nothing under it.
 */
export function permissionGroupSections(
  permissions: ReadonlyArray<CompanyPermission> = COMPANY_PERMISSIONS,
): ReadonlyArray<PermissionGroupSection> {
  return PERMISSION_GROUPS.flatMap((group) => {
    const grouped = permissions.filter(
      (permission) => PERMISSION_CATALOG[permission].group === group,
    );
    return grouped.length === 0 ? [] : [{ group, permissions: grouped }];
  });
}
