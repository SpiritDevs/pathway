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
  RotateCcwIcon,
  ShieldIcon,
  Trash2Icon,
  UsersRoundIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { newCompanyDomainId } from "../../../cloud/companyAdmin";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { SettingsPageContainer, SettingsSection } from "../settingsLayout";
import {
  deriveMemberRows,
  deriveTeamRows,
  permissionGate,
  sortRoles,
  type CompanyMemberRow,
  type CompanyTeamRow,
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

type RoleRow = CompanySettings["directory"]["roles"][number];

function reportError(title: string, error: unknown): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "The company change failed.",
    }),
  );
}

function TeamSheet({
  settings,
  team,
  members,
  open,
  onOpenChange,
}: {
  readonly settings: CompanySettings;
  readonly team: CompanyTeamRow | null;
  readonly members: ReturnType<typeof deriveMemberRows>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(team?.name ?? "");
  const [description, setDescription] = useState(team?.description ?? "");
  const existingMemberIds = new Set(team?.members.map((member) => member.id) ?? []);
  const [memberIds, setMemberIds] =
    useState<ReadonlySet<CompanyMemberRow["id"]>>(existingMemberIds);
  const [pending, setPending] = useState(false);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const memberItems = [...members]
    .sort((a, b) => (a.displayName || a.email).localeCompare(b.displayName || b.email))
    .map((member) => {
      const selected = memberIds.has(member.id);
      const addable = member.state === "active" && team?.archivedAt !== null;
      return {
        id: member.id,
        primaryLabel: member.displayName || member.email,
        secondaryLabel: member.email,
        searchableText: `${member.displayName} ${member.email}`,
        status: member.state,
        statusLabel:
          member.state === "active" ? undefined : member.state === "locked" ? "Locked" : "Left",
        selected,
        mayAdd: addable,
        mayRemove: selected,
        disabledReason:
          !selected && team?.archivedAt !== null
            ? "Archived teams cannot gain members."
            : !selected && member.state !== "active"
              ? `${member.state === "locked" ? "Locked" : "Left"} memberships cannot be added.`
              : undefined,
      } as const;
    });
  const dirty =
    team !== null &&
    (name !== team.name ||
      description !== team.description ||
      memberIds.size !== existingMemberIds.size ||
      [...memberIds].some((id) => !existingMemberIds.has(id)));

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
      const teamId = team?.id ?? TeamId.make(newCompanyDomainId());
      if (team === null) {
        await settings.admin.createTeam({
          companyId: settings.companyId,
          id: teamId,
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
      const addMembershipIds = [...memberIds].filter((id) => !existingMemberIds.has(id));
      const removeMembershipIds = [...existingMemberIds].filter((id) => !memberIds.has(id));
      await settings.admin.updateTeamMembers({
        companyId: settings.companyId,
        teamId,
        addMembershipIds,
        removeMembershipIds,
      });
      onOpenChange(false);
    } catch (error) {
      reportError(team === null ? "Could not create team" : "Could not update team", error);
    } finally {
      setPending(false);
    }
  };

  const changeLifecycle = async (operation: "archive" | "restore") => {
    if (settings.admin === null || settings.companyId === null || team === null || pending) return;
    setPending(true);
    try {
      await (operation === "archive"
        ? settings.admin.archiveTeam({ companyId: settings.companyId, teamId: team.id })
        : settings.admin.restoreTeam({ companyId: settings.companyId, teamId: team.id }));
      onOpenChange(false);
    } catch (error) {
      reportError(`Could not ${operation} team`, error);
    } finally {
      setPending(false);
      setArchiveDialogOpen(false);
    }
  };

  return (
    <CompanySettingsSheet
      open={open}
      onOpenChange={onOpenChange}
      title={team === null ? "Create team" : "Edit team"}
      description="Teams group members and scope access to company work."
      leadingFooter={
        team === null ? null : team.archivedAt === null ? (
          <Button
            type="button"
            variant="ghost"
            className="text-destructive"
            disabled={pending}
            onClick={() => setArchiveDialogOpen(true)}
          >
            <ArchiveIcon /> Archive team
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => void changeLifecycle("restore")}
          >
            <RotateCcwIcon /> Restore team
          </Button>
        )
      }
      footer={
        <>
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={pending || name.trim().length === 0} onClick={() => void submit()}>
            {pending ? "Saving…" : team === null ? "Create team" : "Save changes"}
          </Button>
        </>
      }
    >
      <label className="space-y-1.5">
        <span className="text-xs font-medium">Name</span>
        <Input autoFocus value={name} onChange={(event) => setName(event.currentTarget.value)} />
      </label>
      <label className="space-y-1.5">
        <span className="text-xs font-medium">Description</span>
        <Textarea
          value={description}
          onChange={(event) => setDescription(event.currentTarget.value)}
        />
      </label>
      <CompanyAssignmentPicker
        label="Members"
        items={memberItems}
        pending={pending}
        showStatusFilter
        onToggle={(id, selected) => {
          setMemberIds((current) =>
            applyVisibleAssignmentDelta(current, {
              addIds: selected ? [id] : [],
              removeIds: selected ? [] : [id],
            }),
          );
        }}
        onVisibleChange={(delta) =>
          setMemberIds((current) => applyVisibleAssignmentDelta(current, delta))
        }
      />
      <AlertDialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {team?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Archiving hides this team from new assignments. It does not remove work, memberships,
              roles, or access.{dirty ? " Unsaved form edits will not be saved." : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => void changeLifecycle("archive")}
            >
              Archive team
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </CompanySettingsSheet>
  );
}

function TeamCard({
  settings,
  team,
  onEdit,
}: {
  readonly settings: CompanySettings;
  readonly team: CompanyTeamRow;
  readonly onEdit: () => void;
}) {
  const gate = permissionGate(settings.permissions, "teams.manage");

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
              disabled={!gate.enabled || settings.admin === null}
              onClick={onEdit}
            >
              <PencilIcon className="size-3" /> Edit
            </Button>
          </PermissionTooltip>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {team.members.map((member) => (
          <Badge key={member.id} variant="outline">
            {member.displayName}
          </Badge>
        ))}
        {team.members.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">No members</span>
        ) : null}
      </div>
    </div>
  );
}

function RoleSheet({
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
    <CompanySettingsSheet
      open={open}
      onOpenChange={onOpenChange}
      title={role === null ? "Create role" : "Edit role"}
      description="Role permissions are allow-only. Team-scoped assignments cannot grant company administration."
      footer={
        <>
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={pending || name.trim().length === 0} onClick={() => void submit()}>
            {pending ? "Saving…" : role === null ? "Create role" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-xs font-medium">Name</span>
          <Input autoFocus value={name} onChange={(event) => setName(event.currentTarget.value)} />
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
    </CompanySettingsSheet>
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

export function CompanyTeamsSection({ settings }: { readonly settings: CompanySettings }) {
  const teams = useMemo(() => deriveTeamRows(settings.directory), [settings.directory]);
  const members = useMemo(() => deriveMemberRows(settings.directory), [settings.directory]);
  const [teamSheet, setTeamSheet] = useState<{ open: boolean; team: CompanyTeamRow | null }>({
    open: false,
    team: null,
  });
  const teamGate = permissionGate(settings.permissions, "teams.manage");

  return (
    <>
      <SettingsSection
        id="company-teams"
        title="Teams"
        icon={<UsersRoundIcon className="size-4" />}
        headerAction={
          <PermissionTooltip tooltip={teamGate.tooltip}>
            <Button
              size="sm"
              disabled={!teamGate.enabled || settings.admin === null}
              onClick={() => setTeamSheet({ open: true, team: null })}
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
                onEdit={() => setTeamSheet({ open: true, team })}
              />
            ))
          )}
        </CompanySectionCard>
      </SettingsSection>

      <TeamSheet
        key={`${teamSheet.team?.id ?? "new"}-${teamSheet.open}`}
        settings={settings}
        team={teamSheet.team}
        members={members}
        open={teamSheet.open}
        onOpenChange={(open) => setTeamSheet((current) => ({ ...current, open }))}
      />
    </>
  );
}

export function CompanyRolesSection({ settings }: { readonly settings: CompanySettings }) {
  const roles = useMemo(() => sortRoles(settings.directory.roles), [settings.directory.roles]);
  const [roleSheet, setRoleSheet] = useState<{ open: boolean; role: RoleRow | null }>({
    open: false,
    role: null,
  });
  const roleGate = permissionGate(settings.permissions, "roles.manage");

  return (
    <>
      <SettingsSection
        id="company-roles"
        title="Roles"
        icon={<ShieldIcon className="size-4" />}
        headerAction={
          <PermissionTooltip tooltip={roleGate.tooltip}>
            <Button
              size="sm"
              disabled={!roleGate.enabled || settings.admin === null}
              onClick={() => setRoleSheet({ open: true, role: null })}
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
                onEdit={() => setRoleSheet({ open: true, role })}
              />
            ))
          )}
        </CompanySectionCard>
      </SettingsSection>

      <RoleSheet
        key={`${roleSheet.role?.id ?? "new"}-${roleSheet.open}`}
        settings={settings}
        role={roleSheet.role}
        open={roleSheet.open}
        onOpenChange={(open) => setRoleSheet((current) => ({ ...current, open }))}
      />
    </>
  );
}

function CompanyAdministrationPanel({ page }: { readonly page: "teams" | "roles" }) {
  const settings = useCompanySettings();
  const label = page === "teams" ? "teams" : "roles";

  if (settings.isAuthLoaded && !settings.isSignedIn) {
    return (
      <SettingsPageContainer>
        <CompanySettingsEmptyState
          title={`Sign in to manage ${label}`}
          description="Company administration settings are available after you sign in."
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
          description={`${page === "teams" ? "Team" : "Role"} settings will appear when this workspace is ready.`}
        />
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      {page === "teams" ? (
        <CompanyTeamsSection settings={settings} />
      ) : (
        <CompanyRolesSection settings={settings} />
      )}
    </SettingsPageContainer>
  );
}

export function CompanyTeamsPanel() {
  return <CompanyAdministrationPanel page="teams" />;
}

export function CompanyRolesPanel() {
  return <CompanyAdministrationPanel page="roles" />;
}
