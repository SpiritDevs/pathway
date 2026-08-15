import {
  COMPANY_PERMISSIONS,
  RoleId,
  TeamId,
  type CompanyPermission,
} from "@spiritdevs/contracts/company";
import {
  ArchiveIcon,
  PencilIcon,
  PlusIcon,
  ShieldIcon,
  Trash2Icon,
  UserMinusIcon,
  UsersRoundIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { newCompanyDomainId } from "../../../cloud/companyAdmin";
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
import { Textarea } from "../../ui/textarea";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { SettingsPageContainer, SettingsSection } from "../settingsLayout";
import {
  deriveMemberRows,
  deriveTeamRows,
  permissionGate,
  sortRoles,
  type CompanyTeamRow,
} from "./companySettings.logic";
import {
  CompanySectionCard,
  CompanySettingsEmptyState,
  PermissionTooltip,
} from "./CompanySettingsShared";
import { useCompanySettings } from "./useCompanySettings";

type CompanySettings = ReturnType<typeof useCompanySettings>;
type RoleRow = CompanySettings["directory"]["roles"][number];
const ADD_MEMBER_VALUE = "__add_member__";

function reportError(title: string, error: unknown): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "The company change failed.",
    }),
  );
}

function TeamDialog({
  settings,
  team,
  open,
  onOpenChange,
}: {
  readonly settings: CompanySettings;
  readonly team: CompanyTeamRow | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(team?.name ?? "");
  const [description, setDescription] = useState(team?.description ?? "");
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (
      settings.admin === null ||
      settings.companyId === null ||
      name.trim().length === 0 ||
      pending
    ) {
      return;
    }
    setPending(true);
    try {
      if (team === null) {
        await settings.admin.createTeam({
          companyId: settings.companyId,
          id: TeamId.make(newCompanyDomainId()),
          name,
          description,
        });
      } else {
        await settings.admin.updateTeam({
          companyId: settings.companyId,
          teamId: team.id,
          name,
          description,
        });
      }
      onOpenChange(false);
    } catch (error) {
      reportError(team === null ? "Could not create team" : "Could not update team", error);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{team === null ? "Create team" : "Edit team"}</DialogTitle>
          <DialogDescription>
            Teams group members and scope access to company work.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="space-y-1.5">
            <span className="text-xs font-medium">Name</span>
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium">Description</span>
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
          </label>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={pending} />}>Cancel</DialogClose>
          <Button disabled={pending || name.trim().length === 0} onClick={() => void submit()}>
            {pending ? "Saving…" : team === null ? "Create team" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function TeamCard({
  settings,
  team,
  members,
  onEdit,
}: {
  readonly settings: CompanySettings;
  readonly team: CompanyTeamRow;
  readonly members: ReturnType<typeof deriveMemberRows>;
  readonly onEdit: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const gate = permissionGate(settings.permissions, "teams.manage");
  const existingMemberIds = new Set(team.members.map((member) => member.id));
  const availableMembers = members.filter(
    (member) => member.state === "active" && !existingMemberIds.has(member.id),
  );

  const run = async (key: string, operation: () => Promise<void>) => {
    setPending(key);
    try {
      await operation();
    } catch (error) {
      reportError("Could not update team", error);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-3 border-b px-4 py-4 last:border-b-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{team.name}</h3>
            <Badge variant="secondary">
              {team.members.length} {team.members.length === 1 ? "member" : "members"}
            </Badge>
            {team.archivedAt !== null ? <Badge variant="warning">Archived</Badge> : null}
          </div>
          {team.description ? (
            <p className="mt-1 text-xs text-muted-foreground">{team.description}</p>
          ) : null}
        </div>
        <div className="flex gap-1.5">
          <PermissionTooltip tooltip={gate.tooltip}>
            <Button
              size="xs"
              variant="outline"
              disabled={!gate.enabled || pending !== null}
              onClick={onEdit}
            >
              <PencilIcon className="size-3" /> Rename
            </Button>
          </PermissionTooltip>
          <PermissionTooltip tooltip={gate.tooltip}>
            <Button
              size="xs"
              variant="ghost"
              disabled={!gate.enabled || team.archivedAt !== null || pending !== null}
              onClick={() => {
                const { admin, companyId } = settings;
                if (
                  admin === null ||
                  companyId === null ||
                  !window.confirm(`Archive ${team.name}?`)
                ) {
                  return;
                }
                void run("archive", () => admin.archiveTeam({ companyId, teamId: team.id }));
              }}
            >
              <ArchiveIcon className="size-3" /> Archive
            </Button>
          </PermissionTooltip>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="me-1 text-[11px] font-medium text-muted-foreground">Members</span>
        {team.members.map((member) => (
          <Badge key={member.id} variant="outline">
            {member.displayName}
            <PermissionTooltip tooltip={gate.tooltip}>
              <button
                type="button"
                aria-label={`Remove ${member.displayName} from ${team.name}`}
                disabled={!gate.enabled || pending !== null}
                onClick={() => {
                  const { admin, companyId } = settings;
                  if (admin === null || companyId === null) return;
                  void run(`remove-${member.id}`, () =>
                    admin.removeTeamMember({
                      companyId,
                      teamId: team.id,
                      membershipId: member.id,
                    }),
                  );
                }}
              >
                <UserMinusIcon className="size-2.5" />
              </button>
            </PermissionTooltip>
          </Badge>
        ))}
        {team.members.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">No members</span>
        ) : null}
        {team.archivedAt === null && availableMembers.length > 0 ? (
          <PermissionTooltip tooltip={gate.tooltip}>
            <div>
              <Select
                value={ADD_MEMBER_VALUE}
                disabled={!gate.enabled || pending !== null}
                onValueChange={(value) => {
                  if (
                    value === null ||
                    value === ADD_MEMBER_VALUE ||
                    settings.admin === null ||
                    settings.companyId === null
                  ) {
                    return;
                  }
                  const member = availableMembers.find((candidate) => candidate.id === value);
                  if (!member) return;
                  const { admin, companyId } = settings;
                  if (admin === null || companyId === null) return;
                  void run(`add-${member.id}`, () =>
                    admin.addTeamMember({
                      companyId,
                      teamId: team.id,
                      membershipId: member.id,
                    }),
                  );
                }}
              >
                <SelectTrigger size="xs" className="w-auto min-w-28">
                  <SelectValue>Add member</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  <SelectItem value={ADD_MEMBER_VALUE} disabled>
                    Add member
                  </SelectItem>
                  {availableMembers.map((member) => (
                    <SelectItem key={member.id} value={member.id}>
                      {member.displayName}
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

function RoleDialog({
  settings,
  role,
  open,
  onOpenChange,
}: {
  readonly settings: CompanySettings;
  readonly role: RoleRow | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [permissions, setPermissions] = useState<ReadonlySet<CompanyPermission>>(
    new Set(
      (role?.permissions ?? []).filter((permission): permission is CompanyPermission =>
        COMPANY_PERMISSIONS.includes(permission as CompanyPermission),
      ),
    ),
  );
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (
      settings.admin === null ||
      settings.companyId === null ||
      name.trim().length === 0 ||
      pending
    ) {
      return;
    }
    setPending(true);
    try {
      if (role === null) {
        await settings.admin.createRole({
          companyId: settings.companyId,
          id: RoleId.make(newCompanyDomainId()),
          name,
          description,
          permissions: [...permissions],
        });
      } else {
        await settings.admin.updateRole({
          companyId: settings.companyId,
          roleId: role.id,
          name,
          description,
          permissions: [...permissions],
        });
      }
      onOpenChange(false);
    } catch (error) {
      reportError(role === null ? "Could not create role" : "Could not update role", error);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{role === null ? "Create role" : "Edit role"}</DialogTitle>
          <DialogDescription>
            Role permissions are allow-only. Team-scoped assignments cannot grant company
            administration.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-xs font-medium">Name</span>
              <Input
                autoFocus
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-medium">Description</span>
              <Input
                value={description}
                onChange={(event) => setDescription(event.currentTarget.value)}
              />
            </label>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium">Permissions</legend>
            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {COMPANY_PERMISSIONS.map((permission) => (
                <label
                  key={permission}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"
                >
                  <Checkbox
                    checked={permissions.has(permission)}
                    onCheckedChange={() => {
                      const next = new Set(permissions);
                      if (next.has(permission)) next.delete(permission);
                      else next.add(permission);
                      setPermissions(next);
                    }}
                  />
                  <span className="truncate font-mono text-[11px]">{permission}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={pending} />}>Cancel</DialogClose>
          <Button disabled={pending || name.trim().length === 0} onClick={() => void submit()}>
            {pending ? "Saving…" : role === null ? "Create role" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function RoleCard({
  settings,
  role,
  onEdit,
}: {
  readonly settings: CompanySettings;
  readonly role: RoleRow;
  readonly onEdit: () => void;
}) {
  const [pending, setPending] = useState(false);
  const gate = permissionGate(settings.permissions, "roles.manage");
  return (
    <div className="space-y-3 border-b px-4 py-4 last:border-b-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">{role.name}</h3>
            {role.seeded ? <Badge variant="secondary">Default</Badge> : null}
          </div>
          {role.description ? (
            <p className="mt-1 text-xs text-muted-foreground">{role.description}</p>
          ) : null}
        </div>
        <div className="flex gap-1.5">
          <PermissionTooltip tooltip={gate.tooltip}>
            <Button
              size="xs"
              variant="outline"
              disabled={!gate.enabled || pending}
              onClick={onEdit}
            >
              <PencilIcon className="size-3" /> Edit
            </Button>
          </PermissionTooltip>
          <PermissionTooltip tooltip={gate.tooltip}>
            <Button
              size="xs"
              variant="ghost"
              className="text-destructive"
              disabled={!gate.enabled || pending}
              onClick={() => {
                if (
                  settings.admin === null ||
                  settings.companyId === null ||
                  !window.confirm(`Delete the ${role.name} role and all of its assignments?`)
                ) {
                  return;
                }
                setPending(true);
                void settings.admin
                  .removeRole({ companyId: settings.companyId, roleId: role.id })
                  .catch((error) => reportError("Could not delete role", error))
                  .finally(() => setPending(false));
              }}
            >
              <Trash2Icon className="size-3" /> Delete
            </Button>
          </PermissionTooltip>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {role.permissions.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">No permissions</span>
        ) : (
          role.permissions.map((permission) => (
            <Badge key={permission} variant="outline" className="font-mono">
              {permission}
            </Badge>
          ))
        )}
      </div>
    </div>
  );
}

export function CompanyTeamsRolesPanel() {
  const settings = useCompanySettings();
  const teams = useMemo(() => deriveTeamRows(settings.directory), [settings.directory]);
  const members = useMemo(() => deriveMemberRows(settings.directory), [settings.directory]);
  const roles = useMemo(() => sortRoles(settings.directory.roles), [settings.directory.roles]);
  const [teamDialog, setTeamDialog] = useState<{ open: boolean; team: CompanyTeamRow | null }>({
    open: false,
    team: null,
  });
  const [roleDialog, setRoleDialog] = useState<{ open: boolean; role: RoleRow | null }>({
    open: false,
    role: null,
  });
  const teamGate = permissionGate(settings.permissions, "teams.manage");
  const roleGate = permissionGate(settings.permissions, "roles.manage");

  if (settings.isAuthLoaded && !settings.isSignedIn) {
    return (
      <SettingsPageContainer>
        <CompanySettingsEmptyState
          title="Sign in to manage teams and roles"
          description="Company teams, rosters, and permission roles are available after you sign in."
        />
      </SettingsPageContainer>
    );
  }
  if (settings.activeCompany === null || settings.companyId === null) {
    return (
      <SettingsPageContainer>
        <CompanySettingsEmptyState
          title="No active company"
          description="Choose a company from the company switcher to manage its teams and roles."
        />
      </SettingsPageContainer>
    );
  }
  if (settings.replica === null) {
    return (
      <SettingsPageContainer>
        <CompanySettingsEmptyState
          title="Company data is syncing"
          description="Team and role settings will appear when this company's replica is ready."
        />
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Teams"
        icon={<UsersRoundIcon className="size-4" />}
        headerAction={
          <PermissionTooltip tooltip={teamGate.tooltip}>
            <Button
              size="sm"
              disabled={!teamGate.enabled || settings.admin === null}
              onClick={() => setTeamDialog({ open: true, team: null })}
            >
              <PlusIcon className="size-3.5" /> Create team
            </Button>
          </PermissionTooltip>
        }
      >
        <CompanySectionCard>
          {teams.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              No teams yet. Create one to group members and scope access.
            </div>
          ) : (
            teams.map((team) => (
              <TeamCard
                key={team.id}
                settings={settings}
                team={team}
                members={members}
                onEdit={() => setTeamDialog({ open: true, team })}
              />
            ))
          )}
        </CompanySectionCard>
      </SettingsSection>

      <SettingsSection
        title="Roles"
        icon={<ShieldIcon className="size-4" />}
        headerAction={
          <PermissionTooltip tooltip={roleGate.tooltip}>
            <Button
              size="sm"
              disabled={!roleGate.enabled || settings.admin === null}
              onClick={() => setRoleDialog({ open: true, role: null })}
            >
              <PlusIcon className="size-3.5" /> Create role
            </Button>
          </PermissionTooltip>
        }
      >
        <CompanySectionCard>
          {roles.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              No roles are available in this company replica.
            </div>
          ) : (
            roles.map((role) => (
              <RoleCard
                key={role.id}
                settings={settings}
                role={role}
                onEdit={() => setRoleDialog({ open: true, role })}
              />
            ))
          )}
        </CompanySectionCard>
      </SettingsSection>

      <TeamDialog
        key={`${teamDialog.team?.id ?? "new"}-${teamDialog.open}`}
        settings={settings}
        team={teamDialog.team}
        open={teamDialog.open}
        onOpenChange={(open) => setTeamDialog((current) => ({ ...current, open }))}
      />
      <RoleDialog
        key={`${roleDialog.role?.id ?? "new"}-${roleDialog.open}`}
        settings={settings}
        role={roleDialog.role}
        open={roleDialog.open}
        onOpenChange={(open) => setRoleDialog((current) => ({ ...current, open }))}
      />
    </SettingsPageContainer>
  );
}
