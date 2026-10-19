import { FolderGit2Icon, FolderPlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { SidebarProjectSnapshot } from "~/sidebarProjectGrouping";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import type { ProjectRepositoryChoice } from "./projectRepositoryChoice.logic";

export function ProjectRepositoryChoiceDialog({
  open,
  projectName,
  candidates,
  submitting,
  onOpenChange,
  onConfirm,
}: {
  readonly open: boolean;
  readonly projectName: string;
  readonly candidates: ReadonlyArray<SidebarProjectSnapshot>;
  readonly submitting: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: (choice: ProjectRepositoryChoice) => void;
}) {
  const [choice, setChoice] = useState<ProjectRepositoryChoice | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!open) {
      setReady(false);
      return;
    }
    setChoice(null);
    // The picker is commonly opened by Enter. Arm confirmation on the next frame so that key
    // cannot carry through focus transfer and accept the default Existing project choice.
    setReady(false);
    const frame = window.requestAnimationFrame(() => setReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, [candidates, open]);

  const selectedProject =
    choice?.kind === "existing"
      ? (candidates.find((candidate) => candidate.projectKey === choice.projectKey) ??
        candidates[0] ??
        null)
      : (candidates[0] ?? null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>This repository is already in Pathway</DialogTitle>
          <DialogDescription>
            Choose whether “{projectName}” is another connection to an existing project or a new
            project of its own.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div
            className="grid grid-cols-2 gap-3"
            role="radiogroup"
            aria-label="Project destination"
          >
            <button
              aria-checked={choice?.kind === "existing"}
              className={cn(
                "flex aspect-square min-h-36 flex-col items-start justify-between rounded-xl border p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                choice?.kind === "existing"
                  ? "border-primary bg-primary/[0.06]"
                  : "border-border bg-muted/15 hover:bg-muted/30",
              )}
              disabled={submitting}
              onClick={() =>
                setChoice({
                  kind: "existing",
                  projectKey: selectedProject?.projectKey ?? candidates[0]?.projectKey ?? "",
                })
              }
              role="radio"
              type="button"
            >
              <FolderGit2Icon className="size-5 text-muted-foreground" />
              <span>
                <span className="block text-sm font-semibold text-foreground">
                  Existing project
                </span>
                <span className="mt-1 line-clamp-2 block text-xs leading-relaxed text-muted-foreground">
                  {selectedProject?.displayName ?? "Choose a project"}
                </span>
              </span>
            </button>
            <button
              aria-checked={choice?.kind === "new"}
              className={cn(
                "flex aspect-square min-h-36 flex-col items-start justify-between rounded-xl border p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                choice?.kind === "new"
                  ? "border-primary bg-primary/[0.06]"
                  : "border-border bg-muted/15 hover:bg-muted/30",
              )}
              disabled={submitting}
              onClick={() => setChoice({ kind: "new" })}
              role="radio"
              type="button"
            >
              <FolderPlusIcon className="size-5 text-muted-foreground" />
              <span>
                <span className="block text-sm font-semibold text-foreground">New project</span>
                <span className="mt-1 line-clamp-2 block text-xs leading-relaxed text-muted-foreground">
                  Keep this directory separate, even though the Git remote matches.
                </span>
              </span>
            </button>
          </div>
          {candidates.length > 1 && choice?.kind === "existing" ? (
            <Select
              aria-label="Existing project"
              disabled={submitting}
              onValueChange={(projectKey) => {
                if (projectKey !== null) setChoice({ kind: "existing", projectKey });
              }}
              value={selectedProject?.projectKey ?? null}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose an existing project">
                  {selectedProject?.displayName ?? null}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {candidates.map((candidate) => (
                  <SelectItem key={candidate.projectKey} value={candidate.projectKey}>
                    {candidate.displayName}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button disabled={submitting} onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={
              !ready ||
              submitting ||
              choice === null ||
              (choice.kind === "existing" && selectedProject === null)
            }
            onClick={() =>
              ready && choice !== null
                ? onConfirm(
                    choice.kind === "existing" && selectedProject !== null
                      ? { kind: "existing", projectKey: selectedProject.projectKey }
                      : choice,
                  )
                : undefined
            }
          >
            {submitting ? "Adding…" : "Continue"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
