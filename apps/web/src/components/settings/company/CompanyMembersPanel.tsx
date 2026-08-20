import {
  CompanyInvitationId,
  RoleAssignmentId,
  RoleId,
  type TeamId,
} from "@spiritdevs/contracts/company";
import {
  LockIcon,
  MailPlusIcon,
  PencilIcon,
  RefreshCwIcon,
  UserMinusIcon,
  UserRoundCheckIcon,
  UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { newCompanyDomainId, type CompanyInvitationSummary } from "../../../cloud/companyAdmin";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { SettingsPageContainer, SettingsSection } from "../settingsLayout";
import {
  deriveMemberRows,
  permissionGate,
  sortRoles,
  type CompanyMemberRow,
} from "./companySettings.logic";
import {
  CompanySectionCard,
  CompanySettingsEmptyState,
  PermissionTooltip,
} from "./CompanySettingsShared";
import { CompanySettingsSheet } from "./CompanySettingsSheet";
import { CompanyAssignmentPicker } from "./CompanyAssignmentPicker";
import { applyVisibleAssignmentDelta } from "./companyAssignmentPicker.logic";
import { useCompanySettings, type CompanySettings } from "./useCompanySettings";

function reportError(title: string, error: unknown): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "The company change failed.",
    }),
  );
}

function memberStateBadge(state: CompanyMemberRow["state"]) {
  if (state === "active") return <Badge variant="success">Active</Badge>;
  if (state === "locked") return <Badge variant="warning">Locked</Badge>;
  return <Badge variant="secondary">Left</Badge>;
}

function InviteMemberSheet({
  settings,
  open,
  onOpenChange,
  onInvited,
}: {
  readonly settings: CompanySettings;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onInvited: () => Promise<void>;
}) {
  const { admin, companyId, directory } = settings;
  const [email, setEmail] = useState("");
  const [roleIds, setRoleIds] = useState<ReadonlySet<RoleId>>(new Set());
  const [teamIds, setTeamIds] = useState<ReadonlySet<TeamId>>(new Set());
  const [pending, setPending] = useState(false);
  const roles = [...sortRoles(directory.roles)].sort((a, b) => a.name.localeCompare(b.name));
  const teams = directory.teams
    .filter((team) => team.archivedAt === null)
    .sort((a, b) => a.name.localeCompare(b.name));
  const roleItems = roles.map((role) => ({
    id: role.id,
    primaryLabel: role.name,
    secondaryLabel: role.description || `${role.permissions.length} permissions`,
    searchableText: `${role.name} ${role.description}`,
    selected: roleIds.has(role.id),
    mayAdd: true,
    mayRemove: true,
  }));
  const teamItems = teams.map((team) => ({
    id: team.id,
    primaryLabel: team.name,
    secondaryLabel: team.description,
    searchableText: `${team.name} ${team.description}`,
    selected: teamIds.has(team.id),
    mayAdd: true,
    mayRemove: true,
  }));

  const toggle = <A,>(values: ReadonlySet<A>, value: A): ReadonlySet<A> => {
    const next = new Set(values);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const submit = async () => {
    if (admin === null || companyId === null || email.trim().length === 0 || pending) return;
    setPending(true);
    try {
      await admin.createInvitation({
        companyId,
        id: CompanyInvitationId.make(newCompanyDomainId()),
        email: email.trim(),
        teamIds: [...teamIds],
        roleIds: [...roleIds],
      });
      await onInvited();
      setEmail("");
      setRoleIds(new Set());
      setTeamIds(new Set());
      onOpenChange(false);
    } catch (error) {
      reportError("Could not invite member", error);
      await onInvited();
    } finally {
      setPending(false);
    }
  };

  return (
    <CompanySettingsSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Invite member"
      description="Send an email invitation and optionally grant company roles and team access."
      footer={
        <>
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={pending || email.trim().length === 0} onClick={() => void submit()}>
            {pending ? "Sending…" : "Send invitation"}
          </Button>
        </>
      }
    >
      <label className="space-y-1.5">
        <span className="text-xs font-medium">Email address</span>
        <Input
          autoFocus
          type="email"
          value={email}
          placeholder="person@example.com"
          onChange={(event) => setEmail(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
          }}
        />
      </label>
      <CompanyAssignmentPicker
        key={`invite-roles-${open}`}
        label="Company roles"
        items={roleItems}
        pending={pending}
        onToggle={(id) => setRoleIds(toggle(roleIds, id))}
        onVisibleChange={(delta) =>
          setRoleIds((current) => applyVisibleAssignmentDelta(current, delta))
        }
      />
      <CompanyAssignmentPicker
        key={`invite-teams-${open}`}
        label="Teams"
        items={teamItems}
        pending={pending}
        onToggle={(id) => setTeamIds(toggle(teamIds, id))}
        onVisibleChange={(delta) =>
          setTeamIds((current) => applyVisibleAssignmentDelta(current, delta))
        }
      />
    </CompanySettingsSheet>
  );
}

function PendingInvitations({
  settings,
  invitations,
  onRefresh,
}: {
  readonly settings: CompanySettings;
  readonly invitations: ReadonlyArray<CompanyInvitationSummary>;
  readonly onRefresh: () => Promise<void>;
}) {
  const { admin, companyId, permissions } = settings;
  const [pendingId, setPendingId] = useState<string | null>(null);
  const inviteGate = permissionGate(permissions, "members.invite");
  const pending = invitations.filter((invitation) => invitation.state === "pending");
  if (pending.length === 0) return null;

  const act = async (invitation: CompanyInvitationSummary, operation: "resend" | "revoke") => {
    if (admin === null || companyId === null) return;
    setPendingId(invitation.id);
    try {
      if (operation === "resend") {
        await admin.resendInvitation({ companyId, invitationId: invitation.id });
      } else {
        await admin.revokeInvitation({ companyId, invitationId: invitation.id });
      }
      await onRefresh();
    } catch (error) {
      reportError(`Could not ${operation} invitation`, error);
    } finally {
      setPendingId(null);
    }
  };

  return (
    <SettingsSection title="Pending invitations" icon={<MailPlusIcon className="size-4" />}>
      <CompanySectionCard>
        {pending.map((invitation) => (
          <div
            key={invitation.id}
            className="flex flex-col gap-3 border-b px-4 py-3 last:border-b-0 sm:flex-row sm:items-center"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{invitation.email}</p>
              <p className="text-xs text-muted-foreground">
                Expires {new Date(invitation.expiresAt).toLocaleDateString()} · Sent{" "}
                {invitation.deliveryAttempt} {invitation.deliveryAttempt === 1 ? "time" : "times"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <PermissionTooltip tooltip={inviteGate.tooltip}>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!inviteGate.enabled || pendingId === invitation.id}
                  onClick={() => void act(invitation, "resend")}
                >
                  <RefreshCwIcon className="size-3" /> Resend
                </Button>
              </PermissionTooltip>
              <PermissionTooltip tooltip={inviteGate.tooltip}>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!inviteGate.enabled || pendingId === invitation.id}
                  onClick={() => void act(invitation, "revoke")}
                >
                  Revoke
                </Button>
              </PermissionTooltip>
            </div>
          </div>
        ))}
      </CompanySectionCard>
    </SettingsSection>
  );
}

function MemberEditSheet({
  settings,
  member,
  open,
  onOpenChange,
}: {
  readonly settings: CompanySettings;
  readonly member: CompanyMemberRow;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { admin, companyId, directory, permissions } = settings;
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const manageMembersGate = permissionGate(permissions, "members.manage");
  const manageRolesGate = permissionGate(permissions, "roles.manage");
  const manageTeamsGate = permissionGate(permissions, "teams.manage");
  const assignedCompanyRoleIds = new Set(
    member.roles.filter((role) => role.isCompanyScoped).map((role) => role.roleId),
  );
  const assignedTeamIds = new Set(member.teams.map((team) => team.id));
  const roles = [...sortRoles(directory.roles)].sort((a, b) => a.name.localeCompare(b.name));
  const teams = directory.teams
    .filter((team) => team.archivedAt === null || assignedTeamIds.has(team.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const roleItems = roles.map((role) => {
    const selected = assignedCompanyRoleIds.has(role.id);
    return {
      id: role.id,
      primaryLabel: role.name,
      secondaryLabel: role.description || `${role.permissions.length} permissions`,
      searchableText: `${role.name} ${role.description}`,
      selected,
      mayAdd: member.state === "active" && manageRolesGate.enabled,
      mayRemove: selected && manageRolesGate.enabled,
      disabledReason: !manageRolesGate.enabled
        ? (manageRolesGate.tooltip ?? undefined)
        : !selected && member.state !== "active"
          ? "Only active memberships may receive new roles."
          : undefined,
    };
  });
  const teamItems = teams.map((team) => {
    const selected = assignedTeamIds.has(team.id);
    return {
      id: team.id,
      primaryLabel: team.name,
      secondaryLabel: team.description,
      searchableText: `${team.name} ${team.description}`,
      status: team.archivedAt === null ? undefined : ("archived" as const),
      statusLabel: team.archivedAt === null ? undefined : "Archived",
      selected,
      mayAdd: team.archivedAt === null && member.state === "active" && manageTeamsGate.enabled,
      mayRemove: selected && manageTeamsGate.enabled,
      disabledReason: !manageTeamsGate.enabled
        ? (manageTeamsGate.tooltip ?? undefined)
        : !selected && team.archivedAt !== null
          ? "Archived teams cannot gain members."
          : !selected && member.state !== "active"
            ? "Only active memberships may join teams."
            : undefined,
    };
  });

  const run = async (label: string, operation: () => Promise<void>): Promise<boolean> => {
    if (pendingAction !== null) return false;
    setPendingAction(label);
    try {
      await operation();
      return true;
    } catch (error) {
      reportError("Could not update member", error);
      return false;
    } finally {
      setPendingAction(null);
    }
  };

  const toggleRole = (roleId: RoleId, assigned: boolean) => {
    if (admin === null || companyId === null) return;
    if (assigned) {
      void run(`roles-assign-${roleId}`, () =>
        admin.assignRole({
          companyId,
          id: RoleAssignmentId.make(newCompanyDomainId()),
          membershipId: member.id,
          assignment: { roleId, scope: { kind: "company" } },
        }),
      );
      return;
    }
    const assignment = member.roles.find((role) => role.isCompanyScoped && role.roleId === roleId);
    if (assignment === undefined) return;
    void run(`roles-unassign-${assignment.assignmentId}`, () =>
      admin.unassignRole({ companyId, assignmentId: assignment.assignmentId }),
    );
  };

  return (
    <CompanySettingsSheet
      open={open}
      onOpenChange={onOpenChange}
      title={member.displayName || member.email}
      description={`Manage ${member.email}'s company access.`}
      footer={<Button onClick={() => onOpenChange(false)}>Done</Button>}
    >
      <div className="flex flex-wrap items-center gap-2">
        {memberStateBadge(member.state)}
        {member.isOwner ? <Badge variant="info">Owner</Badge> : null}
        <span className="text-xs text-muted-foreground">{member.email}</span>
      </div>

      <CompanyAssignmentPicker
        label="Company roles"
        items={roleItems}
        pending={pendingAction !== null}
        onToggle={(id, selected) => toggleRole(id, selected)}
        onVisibleChange={(delta) => {
          if (admin === null || companyId === null) return;
          const removeAssignmentIds = delta.removeIds.flatMap((roleId) => {
            const assignment = member.roles.find(
              (candidate) => candidate.isCompanyScoped && candidate.roleId === roleId,
            );
            return assignment ? [assignment.assignmentId] : [];
          });
          void run("roles-bulk", () =>
            admin.updateMemberCompanyRoles({
              companyId,
              membershipId: member.id,
              additions: delta.addIds.map((roleId) => ({
                id: RoleAssignmentId.make(newCompanyDomainId()),
                roleId,
              })),
              removeAssignmentIds,
            }),
          );
        }}
      />

      <CompanyAssignmentPicker
        label="Teams"
        items={teamItems}
        pending={pendingAction !== null}
        onToggle={(teamId, selected) => {
          if (admin === null || companyId === null) return;
          void run(`teams-${selected ? "add" : "remove"}-${teamId}`, () =>
            selected
              ? admin.addTeamMember({ companyId, teamId, membershipId: member.id })
              : admin.removeTeamMember({ companyId, teamId, membershipId: member.id }),
          );
        }}
        onVisibleChange={(delta) => {
          if (admin === null || companyId === null) return;
          void run("teams-bulk", () =>
            admin.updateMemberTeams({
              companyId,
              membershipId: member.id,
              addTeamIds: delta.addIds,
              removeTeamIds: delta.removeIds,
            }),
          );
        }}
      />

      {member.state !== "left" ? (
        <div className="space-y-3 border-t pt-5">
          <div>
            <p className="text-xs font-medium">Member access</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Deactivate access temporarily, or remove this person from the company.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <PermissionTooltip tooltip={manageMembersGate.tooltip}>
              <Button
                variant="outline"
                disabled={!manageMembersGate.enabled || pendingAction !== null}
                onClick={() => {
                  if (admin === null || companyId === null) return;
                  const nextState = member.state === "locked" ? "active" : "locked";
                  void run(nextState, () =>
                    admin.setMembershipState({
                      companyId,
                      membershipId: member.id,
                      state: nextState,
                    }),
                  );
                }}
              >
                {member.state === "locked" ? <UserRoundCheckIcon /> : <LockIcon />}
                {member.state === "locked" ? "Reactivate member" : "Deactivate member"}
              </Button>
            </PermissionTooltip>
            <PermissionTooltip tooltip={manageMembersGate.tooltip}>
              <Button
                variant="ghost"
                className="text-destructive"
                disabled={!manageMembersGate.enabled || pendingAction !== null}
                onClick={() => {
                  if (
                    admin === null ||
                    companyId === null ||
                    !window.confirm(
                      `Remove ${member.displayName || member.email} from the company?`,
                    )
                  ) {
                    return;
                  }
                  void run("remove", () =>
                    admin.removeMembership({ companyId, membershipId: member.id }),
                  ).then((removed) => {
                    if (removed) onOpenChange(false);
                  });
                }}
              >
                <UserMinusIcon /> Remove member
              </Button>
            </PermissionTooltip>
          </div>
        </div>
      ) : null}
    </CompanySettingsSheet>
  );
}

function MemberRow({
  settings,
  member,
}: {
  readonly settings: CompanySettings;
  readonly member: CompanyMemberRow;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const manageMembersGate = permissionGate(settings.permissions, "members.manage");
  const manageRolesGate = permissionGate(settings.permissions, "roles.manage");
  const manageTeamsGate = permissionGate(settings.permissions, "teams.manage");
  const canEdit = manageMembersGate.enabled || manageRolesGate.enabled || manageTeamsGate.enabled;
  const editTooltip = canEdit
    ? null
    : "Requires members.manage, roles.manage, or teams.manage permission.";

  return (
    <div className="space-y-3 border-b px-4 py-4 last:border-b-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium">{member.displayName || member.email}</p>
            {memberStateBadge(member.state)}
            {member.isOwner ? <Badge variant="info">Owner</Badge> : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">{member.email}</p>
        </div>
        {member.state !== "left" ? (
          <PermissionTooltip tooltip={editTooltip}>
            <Button
              size="xs"
              variant="outline"
              disabled={!canEdit || settings.admin === null}
              onClick={() => setEditOpen(true)}
            >
              <PencilIcon className="size-3" /> Edit
            </Button>
          </PermissionTooltip>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {member.roles.map((role) => (
          <Badge key={role.assignmentId} variant={role.isCompanyScoped ? "outline" : "secondary"}>
            {role.roleName}
            {!role.isCompanyScoped ? ` · ${role.scopeLabel}` : ""}
          </Badge>
        ))}
        {member.teams.map((team) => (
          <Badge key={team.id} variant="secondary">
            {team.name}
          </Badge>
        ))}
        {member.roles.length === 0 && member.teams.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">No roles or teams assigned</span>
        ) : null}
      </div>
      <MemberEditSheet
        key={`${member.id}-${editOpen}`}
        settings={settings}
        member={member}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
    </div>
  );
}

export function CompanyMembersSections({ settings }: { readonly settings: CompanySettings }) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invitations, setInvitations] = useState<ReadonlyArray<CompanyInvitationSummary>>([]);
  const [invitationLoadError, setInvitationLoadError] = useState<string | null>(null);
  const members = useMemo(() => deriveMemberRows(settings.directory), [settings.directory]);
  const inviteGate = permissionGate(settings.permissions, "members.invite");

  const refreshInvitations = useCallback(async () => {
    if (settings.admin === null || settings.companyId === null) {
      setInvitations([]);
      return;
    }
    try {
      setInvitations(await settings.admin.listInvitations(settings.companyId));
      setInvitationLoadError(null);
    } catch (error) {
      setInvitationLoadError(
        error instanceof Error ? error.message : "Could not load invitations.",
      );
    }
  }, [settings.admin, settings.companyId]);

  useEffect(() => {
    void refreshInvitations();
  }, [refreshInvitations]);

  return (
    <>
      <SettingsSection
        id="company-members"
        title="Members"
        icon={<UsersIcon className="size-4" />}
        headerAction={
          <PermissionTooltip tooltip={inviteGate.tooltip}>
            <Button
              size="sm"
              disabled={!inviteGate.enabled || settings.admin === null}
              onClick={() => setInviteOpen(true)}
            >
              <MailPlusIcon className="size-3.5" /> Invite member
            </Button>
          </PermissionTooltip>
        }
      >
        <CompanySectionCard>
          {members.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              No members are available in this company replica.
            </div>
          ) : (
            members.map((member) => (
              <MemberRow key={member.id} member={member} settings={settings} />
            ))
          )}
        </CompanySectionCard>
      </SettingsSection>

      {invitationLoadError ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          <span>{invitationLoadError}</span>
          <Button size="xs" variant="ghost" onClick={() => void refreshInvitations()}>
            Retry
          </Button>
        </div>
      ) : null}
      <PendingInvitations
        settings={settings}
        invitations={invitations}
        onRefresh={refreshInvitations}
      />
      <InviteMemberSheet
        settings={settings}
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvited={refreshInvitations}
      />
    </>
  );
}

export function CompanyMembersPanel() {
  const settings = useCompanySettings();

  if (settings.isAuthLoaded && !settings.isSignedIn) {
    return (
      <SettingsPageContainer>
        <CompanySettingsEmptyState
          title="Sign in to manage company members"
          description="Company membership, invitations, and roles are available after you sign in."
        />
      </SettingsPageContainer>
    );
  }
  if (settings.activeCompany === null || settings.companyId === null) {
    return (
      <SettingsPageContainer>
        <CompanySettingsEmptyState
          title="No active workspace"
          description="Your workspace is still being prepared. Try again in a moment."
        />
      </SettingsPageContainer>
    );
  }
  if (settings.replica === null) {
    return (
      <SettingsPageContainer>
        <CompanySettingsEmptyState
          title="Workspace data is syncing"
          description="Member settings will appear when this workspace is ready."
        />
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <CompanyMembersSections settings={settings} />
    </SettingsPageContainer>
  );
}
