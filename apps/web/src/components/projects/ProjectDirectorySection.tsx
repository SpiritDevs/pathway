/**
 * Directory + git options, shared verbatim by the attach dialog and the quick-create dialog's
 * expandable section so the two never drift on what "set a directory" means.
 *
 * @module components/projects/ProjectDirectorySection
 */
import type { EnvironmentId } from "@t3tools/contracts";

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
        onChange={(path) => onChange({ ...draft, path })}
        platform={platform}
        value={draft.path}
      />
      <label className="flex cursor-pointer items-start gap-2.5">
        <Checkbox
          checked={draft.createIfMissing}
          className="mt-0.5"
          disabled={disabled}
          onCheckedChange={(checked) => onChange({ ...draft, createIfMissing: checked === true })}
        />
        <span className="min-w-0">
          <span className="block text-xs font-medium text-foreground">
            Create the directory if it does not exist
          </span>
          <span className="block text-xs leading-snug text-muted-foreground">
            Otherwise the path has to already be there.
          </span>
        </span>
      </label>
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
