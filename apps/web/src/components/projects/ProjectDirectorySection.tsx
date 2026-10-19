/**
 * Directory + git options, shared verbatim by the attach dialog and the quick-create dialog's
 * expandable section so the two never drift on what "set a directory" means.
 *
 * @module components/projects/ProjectDirectorySection
 */
import type { EnvironmentId } from "@spiritdevs/contracts";

import { Checkbox } from "../ui/checkbox";
import { ProjectDirectoryField } from "./ProjectDirectoryField";
import type { AttachProjectDirectoryDraft } from "./projectWorkspace.logic";

export function ProjectDirectorySection({
  environmentId,
  platform,
  currentProjectCwd,
  draft,
  onChange,
  disabled = false,
  autoFocus = false,
}: {
  environmentId: EnvironmentId | null;
  platform: string;
  currentProjectCwd: string | null;
  draft: AttachProjectDirectoryDraft;
  onChange: (next: AttachProjectDirectoryDraft) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <ProjectDirectoryField
        autoFocus={autoFocus}
        currentProjectCwd={currentProjectCwd}
        disabled={disabled}
        environmentId={environmentId}
        onChange={(path, createIfMissing) => onChange({ ...draft, path, createIfMissing })}
        platform={platform}
        value={draft.path}
      />
      <label className="flex cursor-pointer items-start gap-2.5">
        <Checkbox
          checked={draft.initializeGit}
          className="mt-0.5"
          disabled={disabled}
          onCheckedChange={(checked) => onChange({ ...draft, initializeGit: checked === true })}
        />
        <span className="min-w-0">
          <span className="block text-xs font-medium text-foreground">
            Initialize a git repository
          </span>
          <span className="block text-xs leading-snug text-muted-foreground">
            Leave this off if the directory is already a checkout — Pathway detects that on its own.
          </span>
        </span>
      </label>
    </div>
  );
}
