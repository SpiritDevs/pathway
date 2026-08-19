import { CheckIcon, ShieldCheckIcon, UserRoundPlusIcon, UsersRoundIcon } from "lucide-react";
import { Navigate } from "@tanstack/react-router";
import { useState } from "react";

import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { SettingsPageContainer, SettingsSection } from "../settingsLayout";
import { CompanySettingsEmptyState, CompanySectionCard } from "./CompanySettingsShared";
import { useCompanySettings, type CompanySettings } from "./useCompanySettings";

type WorkspaceKind = "personal" | "organization";

export function companyWorkspaceKind(
  company: CompanySettings["directory"]["company"],
): WorkspaceKind {
  return company?.workspaceKind ?? "organization";
}

const COMPANY_BENEFITS = [
  {
    icon: UserRoundPlusIcon,
    title: "Bring people into your workspace",
    description: "Invite teammates to work from the same projects, threads, and environments.",
  },
  {
    icon: UsersRoundIcon,
    title: "Organize work with teams",
    description: "Group members around the products and workstreams they own.",
  },
  {
    icon: ShieldCheckIcon,
    title: "Control access with roles",
    description: "Give each person the permissions they need without sharing full control.",
  },
] as const;

function PersonalWorkspaceUpgrade({ settings }: { readonly settings: CompanySettings }) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmedName = name.trim();

  const createOrganization = async () => {
    if (settings.admin === null || trimmedName.length === 0 || pending || completed) {
      return;
    }

    setPending(true);
    setError(null);
    try {
      await settings.admin.createOrganizationWorkspace({ name: trimmedName });
      setCompleted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create this company.");
    } finally {
      setPending(false);
    }
  };

  return (
    <SettingsSection
      id="company-upgrade"
      title="Members & Teams"
      icon={<UsersRoundIcon className="size-4" />}
    >
      <CompanySectionCard>
        <div className="grid lg:grid-cols-[minmax(0,0.9fr)_minmax(22rem,1.1fr)]">
          <div className="flex flex-col justify-between gap-8 border-b p-6 sm:p-8 lg:border-e lg:border-b-0">
            <div className="space-y-4">
              <Badge variant="secondary">Personal workspace</Badge>
              <div className="space-y-2">
                <h3 className="max-w-md text-2xl font-semibold tracking-[-0.035em]">
                  Build together, and keep a space of your own
                </h3>
                <p className="max-w-md text-sm leading-6 text-muted-foreground">
                  Create a company when you are ready to collaborate. This personal workspace stays
                  exactly as it is, with its own projects, threads, and issues.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
              <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-success" />
              Your personal workspace is never replaced. Switch between the two at any time.
            </div>
          </div>

          <div className="p-6 sm:p-8">
            <ul className="divide-y" aria-label="Company workspace benefits">
              {COMPANY_BENEFITS.map(({ icon: Icon, title, description }) => (
                <li key={title} className="flex gap-3 py-4 first:pt-0">
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{title}</p>
                    <p className="text-xs leading-5 text-muted-foreground">{description}</p>
                  </div>
                </li>
              ))}
            </ul>

            <form
              className="mt-5 border-t pt-5"
              onSubmit={(event) => {
                event.preventDefault();
                void createOrganization();
              }}
            >
              <label htmlFor="company-workspace-name" className="text-xs font-medium">
                Company name
              </label>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <Input
                  id="company-workspace-name"
                  value={name}
                  disabled={pending || completed}
                  placeholder="Acme, Inc."
                  autoComplete="organization"
                  aria-describedby={error === null ? undefined : "company-upgrade-error"}
                  aria-invalid={error !== null}
                  onChange={(event) => {
                    setName(event.currentTarget.value);
                    if (error !== null) setError(null);
                  }}
                />
                <Button
                  type="submit"
                  className="shrink-0"
                  disabled={
                    settings.admin === null || trimmedName.length === 0 || pending || completed
                  }
                >
                  {completed ? "Created" : pending ? "Creating…" : "Create company"}
                </Button>
              </div>
              {error !== null ? (
                <p
                  id="company-upgrade-error"
                  role="alert"
                  className="mt-2 text-xs text-destructive"
                >
                  {error}
                </p>
              ) : completed ? (
                <p role="status" className="mt-2 text-xs text-muted-foreground">
                  Your new company will appear in the workspace switcher once it finishes syncing.
                </p>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  This creates a separate company. Nothing moves out of your personal workspace.
                </p>
              )}
            </form>
          </div>
        </div>
      </CompanySectionCard>
    </SettingsSection>
  );
}

export function CompanyMembersTeamsPanel() {
  const settings = useCompanySettings();

  if (settings.isAuthLoaded && !settings.isSignedIn) {
    return (
      <SettingsPageContainer>
        <CompanySettingsEmptyState
          title="Sign in to manage members and teams"
          description="Workspace membership and collaboration settings are available after you sign in."
        />
      </SettingsPageContainer>
    );
  }
  if (settings.activeCompany === null || settings.companyId === null) {
    return (
      <SettingsPageContainer>
        <CompanySettingsEmptyState
          title="Preparing your workspace"
          description="Pathway is creating your personal workspace. This usually takes only a moment."
        />
      </SettingsPageContainer>
    );
  }
  if (settings.replica === null || settings.directory.company === null) {
    return (
      <SettingsPageContainer>
        <CompanySettingsEmptyState
          title="Workspace data is syncing"
          description="Member and team settings will appear when this workspace is ready."
        />
      </SettingsPageContainer>
    );
  }

  if (companyWorkspaceKind(settings.directory.company) === "personal") {
    return (
      <SettingsPageContainer>
        <PersonalWorkspaceUpgrade settings={settings} />
      </SettingsPageContainer>
    );
  }

  return <Navigate to="/settings/company-members" replace />;
}
