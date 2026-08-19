/**
 * Project configuration, opened from the dashboard.
 *
 * This is the same editor as Settings → Projects → [project], not a second one. `ProjectDetail`
 * already takes a plain group snapshot, so the sheet is composition: a field added there appears
 * on both surfaces and the two cannot drift.
 *
 * @module components/projects/ProjectConfigurationSheet
 */
import { useAtomValue } from "@effect/atom-react";

import { companyListAtom } from "~/cloud/activeCompany";
import { Button } from "../ui/button";
import { SheetClose } from "../ui/sheet";
import { CompanySettingsSheet } from "../settings/company/CompanySettingsSheet";
import { ProjectDetail } from "../settings/ProjectSettingsPanel";
import { SettingsSection } from "../settings/settingsLayout";
import type { WorkspaceProject } from "./workspaceProjects.logic";

export function ProjectConfigurationSheet({
  project,
  open,
  onOpenChange,
}: {
  readonly project: WorkspaceProject;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const companies = useAtomValue(companyListAtom);
  const owners = companies.filter((company) => project.companyIds.includes(String(company.id)));

  return (
    <CompanySettingsSheet
      open={open}
      onOpenChange={onOpenChange}
      title={project.displayName}
      description="Name, icon, checkouts, and the defaults new threads start from."
      footer={<SheetClose render={<Button variant="outline" />}>Done</SheetClose>}
    >
      {project.group === null ? (
        // Everything `ProjectDetail` edits — the icon, the checkouts, the thread defaults — belongs
        // to a checkout. A project that has none has nothing here to configure yet, and saying so
        // beats rendering an editor whose every control is disabled.
        <SettingsSection id="project-company" title="Company">
          <p className="text-sm text-muted-foreground">
            {owners.length === 0
              ? "This project has no owning company yet."
              : `Owned by ${owners.map((company) => company.name).join(", ")}.`}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Attach a directory on any machine to set this project&rsquo;s icon, scripts, and
            new-thread defaults.
          </p>
        </SettingsSection>
      ) : (
        <ProjectDetail group={project.group} />
      )}
    </CompanySettingsSheet>
  );
}
