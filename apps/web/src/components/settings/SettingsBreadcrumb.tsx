import { Link } from "@tanstack/react-router";
import { FolderIcon } from "lucide-react";

import { ProjectFavicon } from "../ProjectFavicon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { useWorkspaceProjects } from "../projects/useWorkspaceProjects";
import { useEnvironments } from "../../state/environments";
import { SETTINGS_SECTION_LABELS } from "./settingsSearch";

const SETTINGS_BREADCRUMB_LABELS: Readonly<Record<string, string>> = SETTINGS_SECTION_LABELS;

/** Pages below a section; the crumb shows the section, then the page. */
const SETTINGS_SUBPAGE_LABELS: Readonly<Record<string, string>> = {
  "/settings/appearance/action-palette": "Action Palette",
  "/settings/browser/history": "Browsing history",
  "/settings/browser/downloads": "Download history",
  "/settings/browser/passwords": "Password manager",
  "/settings/browser/contact-info": "Contact info",
  "/settings/browser/site-settings": "Site settings",
  "/settings/browser/extensions": "Extension manager",
};

function settingsBreadcrumbLabel(pathname: string): string | null {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  const exactLabel = SETTINGS_BREADCRUMB_LABELS[normalizedPathname];
  if (exactLabel !== undefined) return exactLabel;
  // Nested routes such as /settings/projects/$projectKey stay under their section's crumb.
  const section = Object.keys(SETTINGS_BREADCRUMB_LABELS).find((path) =>
    normalizedPathname.startsWith(`${path}/`),
  );
  return section === undefined ? null : (SETTINGS_BREADCRUMB_LABELS[section] ?? null);
}

export function settingsProjectKeyFromPathname(pathname: string): string | null {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  const prefix = "/settings/projects/";
  if (!normalizedPathname.startsWith(prefix)) return null;
  const encodedProjectKey = normalizedPathname.slice(prefix.length);
  if (!encodedProjectKey) return null;
  try {
    return decodeURIComponent(encodedProjectKey);
  } catch {
    return encodedProjectKey;
  }
}

export function settingsEmailEnvironmentIdFromPathname(pathname: string): string | null {
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  const prefix = "/settings/email/";
  if (!normalizedPathname.startsWith(prefix)) return null;
  const encodedEnvironmentId = normalizedPathname.slice(prefix.length);
  if (!encodedEnvironmentId) return null;
  try {
    return decodeURIComponent(encodedEnvironmentId);
  } catch {
    return encodedEnvironmentId;
  }
}

function SettingsProjectBreadcrumbItem({ projectKey }: { readonly projectKey: string }) {
  const projects = useWorkspaceProjects();
  const project = projects.find((candidate) => candidate.projectKey === projectKey) ?? null;
  const group = project?.group ?? null;
  const fallbackName = projectKey.split("/").at(-1) || "Project";

  return (
    <WorkspaceBreadcrumbItem current className="gap-1.5 truncate">
      {group === null ? (
        <FolderIcon aria-hidden className="size-4 shrink-0 text-icon-muted" />
      ) : (
        <ProjectFavicon
          environmentId={group.environmentId}
          cwd={group.workspaceRoot}
          faviconPath={group.faviconPath}
          className="size-4"
        />
      )}
      <span className="truncate">{project?.displayName ?? fallbackName}</span>
    </WorkspaceBreadcrumbItem>
  );
}

function SettingsEmailEnvironmentBreadcrumbItem({
  environmentId,
}: {
  readonly environmentId: string;
}) {
  const { environments } = useEnvironments();
  const environment =
    environments.find((candidate) => candidate.environmentId === environmentId) ?? null;

  return (
    <WorkspaceBreadcrumbItem current className="truncate">
      {environment?.label ?? "Environment"}
    </WorkspaceBreadcrumbItem>
  );
}

export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const sectionLabel = settingsBreadcrumbLabel(pathname);
  const projectKey = settingsProjectKeyFromPathname(pathname);
  const emailEnvironmentId = settingsEmailEnvironmentIdFromPathname(pathname);
  const subpageLabel = SETTINGS_SUBPAGE_LABELS[pathname.replace(/\/+$/, "")] ?? null;

  return (
    <WorkspaceBreadcrumb ariaLabel="Settings breadcrumb">
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>Settings</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      {pathname.startsWith("/settings/dictation/") ? (
        <>
          <WorkspaceBreadcrumbItem>Dictation</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      {subpageLabel ? (
        <>
          <WorkspaceBreadcrumbItem>
            {pathname.startsWith("/settings/browser/") ? (
              <Link
                to="/settings/browser"
                className="rounded-sm outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {sectionLabel}
              </Link>
            ) : (
              sectionLabel
            )}
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      {pathname.startsWith("/settings/orchestrators-") ? (
        <>
          <WorkspaceBreadcrumbItem>Orchestrators</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      {projectKey ? (
        <>
          <WorkspaceBreadcrumbItem>
            <Link
              to="/settings/projects"
              className="rounded-sm outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              Projects
            </Link>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          <SettingsProjectBreadcrumbItem projectKey={projectKey} />
        </>
      ) : emailEnvironmentId ? (
        <>
          <WorkspaceBreadcrumbItem>
            <Link
              to="/settings/email"
              className="rounded-sm outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              Capture
            </Link>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          <SettingsEmailEnvironmentBreadcrumbItem environmentId={emailEnvironmentId} />
        </>
      ) : (
        <WorkspaceBreadcrumbItem current className="truncate">
          {subpageLabel ?? sectionLabel ?? "Settings"}
        </WorkspaceBreadcrumbItem>
      )}
    </WorkspaceBreadcrumb>
  );
}
