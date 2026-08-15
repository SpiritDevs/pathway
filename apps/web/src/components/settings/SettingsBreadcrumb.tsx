import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
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

export function SettingsBreadcrumb({ pathname }: { pathname: string }) {
  const sectionLabel = settingsBreadcrumbLabel(pathname);
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
      <WorkspaceBreadcrumbItem current className="truncate">
        {subpageLabel ?? sectionLabel ?? "Settings"}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
