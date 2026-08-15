import {
  CompanyInvitationId,
  RoleAssignmentId,
  RoleId,
  type TeamId,
} from "@spiritdevs/contracts/company";
import {
  LockIcon,
  MailPlusIcon,
  RefreshCwIcon,
  UserMinusIcon,
  UserRoundCheckIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { newCompanyDomainId, type CompanyInvitationSummary } from "../../../cloud/companyAdmin";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
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
import { useCompanySettings } from "./useCompanySettings";

const ADD_ROLE_VALUE = "__add_role__";
type CompanySettings = ReturnType<typeof useCompanySettings>;

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

function InviteMemberDialog({
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
  const roles = sortRoles(directory.roles);
  const teams = directory.teams.filter((team) => team.archivedAt === null);

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Invite member</DialogTitle>
          <DialogDescription>
            Send an email invitation and optionally grant company roles and team access.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
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
          {roles.length > 0 ? (
            <fieldset className="space-y-2">
              <legend className="text-xs font-medium">Company roles</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {roles.map((role) => (
                  <label key={role.id} className="flex items-start gap-2 rounded-lg border p-2.5">
                    <Checkbox
                      checked={roleIds.has(role.id)}
                      onCheckedChange={() => setRoleIds(toggle(roleIds, role.id))}
                    />
                    <span className="min-w-0">
                      <span className="block text-xs font-medium">{role.name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {role.description || `${role.permissions.length} permissions`}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          {teams.length > 0 ? (
            <fieldset className="space-y-2">
              <legend className="text-xs font-medium">Teams</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {teams.map((team) => (
                  <label key={team.id} className="flex items-center gap-2 rounded-lg border p-2.5">
                    <Checkbox
                      checked={teamIds.has(team.id)}
                      onCheckedChange={() => setTeamIds(toggle(teamIds, team.id))}
                    />
                    <span className="truncate text-xs font-medium">{team.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={pending} />}>Cancel</DialogClose>
          <Button disabled={pending || email.trim().length === 0} onClick={() => void submit()}>
            {pending ? "Sending…" : "Send invitation"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
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

function MemberRow({
  settings,
  member,
}: {
  readonly settings: CompanySettings;
  readonly member: CompanyMemberRow;
}) {
  const { admin, companyId, directory, permissions } = settings;
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const manageMembersGate = permissionGate(permissions, "members.manage");
  const manageRolesGate = permissionGate(permissions, "roles.manage");
  const assignedCompanyRoleIds = new Set(
    member.roles.filter((role) => role.isCompanyScoped).map((role) => role.roleId),
  );
  const availableRoles = sortRoles(directory.roles).filter(
    (role) => !assignedCompanyRoleIds.has(role.id),
  );

  const run = async (label: string, operation: () => Promise<void>) => {
    if (pendingAction !== null) return;
    setPendingAction(label);
    try {
      await operation();
    } catch (error) {
      reportError("Could not update member", error);
    } finally {
      setPendingAction(null);
    }
  };

  const assignRole = (roleId: RoleId) => {
    if (admin === null || companyId === null) return;
    void run(`assign-${roleId}`, () =>
      admin.assignRole({
        companyId,
        id: RoleAssignmentId.make(newCompanyDomainId()),
        membershipId: member.id,
        assignment: { roleId, scope: { kind: "company" } },
      }),
    );
  };

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
          {member.teams.length > 0 ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Teams: {member.teams.map((team) => team.name).join(", ")}
            </p>
          ) : null}
        </div>
        {member.state !== "left" ? (
          <div className="flex flex-wrap gap-1.5">
            <PermissionTooltip tooltip={manageMembersGate.tooltip}>
              <Button
                size="xs"
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
                {member.state === "locked" ? (
                  <UserRoundCheckIcon className="size-3" />
                ) : (
                  <LockIcon className="size-3" />
                )}
                {member.state === "locked" ? "Reactivate" : "Deactivate"}
              </Button>
            </PermissionTooltip>
            <PermissionTooltip tooltip={manageMembersGate.tooltip}>
              <Button
                size="xs"
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
                  );
                }}
              >
                <UserMinusIcon className="size-3" /> Remove
              </Button>
            </PermissionTooltip>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="me-1 text-[11px] font-medium text-muted-foreground">Roles</span>
        {member.roles.map((role) => (
          <Badge key={role.assignmentId} variant={role.isCompanyScoped ? "outline" : "secondary"}>
            {role.roleName}
            {!role.isCompanyScoped ? ` · ${role.scopeLabel}` : ""}
            {role.isCompanyScoped && member.state === "active" ? (
              <PermissionTooltip tooltip={manageRolesGate.tooltip}>
                <button
                  type="button"
                  aria-label={`Remove ${role.roleName} role from ${member.displayName}`}
                  disabled={!manageRolesGate.enabled || pendingAction !== null}
                  className="rounded-sm disabled:opacity-50"
                  onClick={() => {
                    if (admin === null || companyId === null) return;
                    void run(`unassign-${role.assignmentId}`, () =>
                      admin.unassignRole({ companyId, assignmentId: role.assignmentId }),
                    );
                  }}
                >
                  <XIcon className="size-2.5" />
                </button>
              </PermissionTooltip>
            ) : null}
          </Badge>
        ))}
        {member.roles.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">No roles assigned</span>
        ) : null}
        {member.state === "active" && availableRoles.length > 0 ? (
          <PermissionTooltip tooltip={manageRolesGate.tooltip}>
            <div>
              <Select
                value={ADD_ROLE_VALUE}
                disabled={!manageRolesGate.enabled || pendingAction !== null}
                onValueChange={(value) => {
                  if (value !== null && value !== ADD_ROLE_VALUE) assignRole(RoleId.make(value));
                }}
              >
                <SelectTrigger size="xs" className="w-auto min-w-24">
                  <SelectValue>Add role</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem value={ADD_ROLE_VALUE} disabled>
                    Add role
                  </SelectItem>
                  {availableRoles.map((role) => (
                    <SelectItem key={role.id} value={role.id}>
                      {role.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          </PermissionTooltip>
        ) : null}
      </div>
    </div>
  );
}

export function CompanyMembersPanel() {
  const settings = useCompanySettings();
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
          title="No active company"
          description="Choose a company from the company switcher to manage its members."
        />
      </SettingsPageContainer>
    );
  }
  if (settings.replica === null) {
    return (
      <SettingsPageContainer>
        <CompanySettingsEmptyState
          title="Company data is syncing"
          description="Member settings will appear when this company's replica is ready."
        />
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection
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
      <InviteMemberDialog
        settings={settings}
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvited={refreshInvitations}
      />
    </SettingsPageContainer>
  );
}
