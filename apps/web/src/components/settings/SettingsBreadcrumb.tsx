import { Link } from "@tanstack/react-router";
import { FolderIcon } from "lucide-react";

import { ProjectFavicon } from "../ProjectFavicon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { useWorkspaceProjects } from "../projects/useWorkspaceProjects";
import { SETTINGS_SECTION_LABELS } from "./settingsSearch";

const SETTINGS_BREADCRUMB_LABELS: Readonly<Record<string, string>> = SETTINGS_SECTION_LABELS;

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

export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const sectionLabel = settingsBreadcrumbLabel(pathname);
  const projectKey = settingsProjectKeyFromPathname(pathname);
  const subpageLabel =
    pathname.replace(/\/+$/, "") === "/settings/appearance/action-palette"
      ? "Action Palette"
      : null;

  return (
    <WorkspaceBreadcrumb ariaLabel="Settings breadcrumb">
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>Settings</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      {subpageLabel ? (
        <>
          <WorkspaceBreadcrumbItem>{sectionLabel}</WorkspaceBreadcrumbItem>
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
      ) : (
        <WorkspaceBreadcrumbItem current className="truncate">
          {subpageLabel ?? sectionLabel ?? "Settings"}
        </WorkspaceBreadcrumbItem>
      )}
    </WorkspaceBreadcrumb>
  );
}
