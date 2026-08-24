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
import { useState } from "react";

import { companyListAtom } from "~/cloud/activeCompany";
import { Button } from "../ui/button";
import { SheetClose } from "../ui/sheet";
import { CompanySettingsSheet } from "../settings/company/CompanySettingsSheet";
import { ProjectDetail } from "../settings/ProjectSettingsPanel";
import { SettingsSection } from "../settings/settingsLayout";
import { MoveProjectWizard } from "./MoveProjectWizard";
import { PendingProjectSetup } from "./PendingProjectSetup";
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
  const [moveOpen, setMoveOpen] = useState(false);
  const canMove = project.cloudProjectId !== null && companies.length > 1;

  return (
    <>
      <MoveProjectWizard project={project} open={moveOpen} onOpenChange={setMoveOpen} />
      <CompanySettingsSheet
        open={open}
        onOpenChange={onOpenChange}
        title={project.displayName}
        description="Name, icon, checkouts, and the defaults new threads start from."
        footer={<SheetClose render={<Button variant="outline" />}>Done</SheetClose>}
      >
        {project.group === null ? (
          <SettingsSection id="project-checkout" title="Pending setup">
            <PendingProjectSetup key={project.projectKey} project={project} />
          </SettingsSection>
        ) : (
          <ProjectDetail group={project.group} />
        )}
        <SettingsSection id="project-owner" title="Company">
          <p className="text-sm text-muted-foreground">
            {owners.length === 0
              ? "This project has no owning company yet."
              : `Owned by ${owners.map((company) => company.name).join(", ")}.`}
          </p>
          {canMove ? (
            <div className="mt-3">
              <Button size="sm" variant="outline" onClick={() => setMoveOpen(true)}>
                Move to another company…
              </Button>
              <p className="mt-2 text-xs text-muted-foreground">
                Issues and milestones move with the project. Issue keys are re-issued under the new
                company&rsquo;s prefix and cannot be changed back.
              </p>
            </div>
          ) : null}
        </SettingsSection>
      </CompanySettingsSheet>
    </>
  );
}
