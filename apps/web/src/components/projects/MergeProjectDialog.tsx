import type { RepositoryIdentity } from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { GitMergeIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { EnvironmentControlClient } from "~/cloud/environmentControl";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import type { WorkspaceProject } from "./workspaceProjects.logic";

export function mergeProjectRepositoryChoices(
  projects: ReadonlyArray<WorkspaceProject>,
): ReadonlyArray<RepositoryIdentity> {
  const choices = new Map<string, RepositoryIdentity>();
  for (const project of projects) {
    for (const identity of project.repositoryIdentities ?? []) {
      choices.set(identity.canonicalKey, identity);
    }
    if (
      project.repositoryIdentity !== undefined &&
      !choices.has(project.repositoryIdentity.canonicalKey)
    ) {
      choices.set(project.repositoryIdentity.canonicalKey, project.repositoryIdentity);
    }
    for (const member of project.group?.memberProjects ?? []) {
      const identity = member.repositoryIdentity;
      if (identity !== undefined && identity !== null) choices.set(identity.canonicalKey, identity);
    }
  }
  return [...choices.values()];
}

export function MergeProjectDialog({
  open,
  onOpenChange,
  project,
  candidates,
  companyId,
  environmentControl,
  onMerged,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly project: WorkspaceProject;
  readonly candidates: ReadonlyArray<WorkspaceProject>;
  readonly companyId: CompanyId;
  readonly environmentControl: EnvironmentControlClient;
  readonly onMerged: () => void;
}) {
  const [sourceId, setSourceId] = useState<string | null>(null);
  const source = candidates.find((candidate) => candidate.cloudProjectId === sourceId) ?? null;
  const repositories = useMemo(
    () => mergeProjectRepositoryChoices(source === null ? [project] : [project, source]),
    [project, source],
  );
  const [repositoryKey, setRepositoryKey] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    if (!open) return;
    const nextSource = candidates[0]?.cloudProjectId ?? null;
    setSourceId(nextSource);
    setRepositoryKey(null);
  }, [candidates, open]);

  useEffect(() => {
    if (repositories.some((identity) => identity.canonicalKey === repositoryKey)) return;
    setRepositoryKey(repositories[0]?.canonicalKey ?? null);
  }, [repositories, repositoryKey]);

  const merge = async () => {
    const targetCloudProjectId = project.cloudProjectId;
    const repositoryIdentity = repositories.find(
      (identity) => identity.canonicalKey === repositoryKey,
    );
    if (sourceId === null || targetCloudProjectId === null || repositoryIdentity === undefined) {
      return;
    }
    setMerging(true);
    try {
      const result = await environmentControl.mergeCompanyProjects({
        companyId,
        sourceCloudProjectId: sourceId,
        targetCloudProjectId,
        repositoryIdentity,
      });
      toastManager.add({
        type: "success",
        title: "Projects merged",
        description: `${result.movedBindings} connection${result.movedBindings === 1 ? "" : "s"} now use ${repositoryIdentity.displayName ?? repositoryIdentity.canonicalKey}.`,
      });
      onOpenChange(false);
      onMerged();
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not merge projects",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    } finally {
      setMerging(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Merge duplicate project</DialogTitle>
          <DialogDescription>
            Connections, threads, and issues move into {project.displayName}. Choose the Git
            repository every connection should use.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <label className="block space-y-2 text-sm">
            <span className="font-medium">Duplicate project</span>
            <Select value={sourceId} onValueChange={setSourceId}>
              <SelectTrigger className="w-full" aria-label="Duplicate project">
                <SelectValue placeholder="Choose a project" />
              </SelectTrigger>
              <SelectPopup>
                {candidates.map((candidate) => (
                  <SelectItem key={candidate.cloudProjectId} value={candidate.cloudProjectId!}>
                    {candidate.displayName}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
          <label className="block space-y-2 text-sm">
            <span className="font-medium">Correct Git repository</span>
            <Select value={repositoryKey} onValueChange={setRepositoryKey}>
              <SelectTrigger className="w-full" aria-label="Correct Git repository">
                <SelectValue placeholder="Choose a repository" />
              </SelectTrigger>
              <SelectPopup>
                {repositories.map((identity) => (
                  <SelectItem key={identity.canonicalKey} value={identity.canonicalKey}>
                    {identity.displayName ?? identity.canonicalKey}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <p className="text-xs text-muted-foreground">
              Pathway updates each checkout’s primary Git remote when that environment is online.
            </p>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={merging}>
              Cancel
            </Button>
            <Button
              onClick={() => void merge()}
              disabled={merging || sourceId === null || repositoryKey === null}
            >
              <GitMergeIcon />
              {merging ? "Merging…" : "Merge projects"}
            </Button>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
