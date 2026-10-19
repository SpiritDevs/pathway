import type {
  EnvironmentId,
  OrchestrationV2WorkspaceMove,
  OrchestrationV2WorkspaceMovePreview,
  ProjectScript,
  ThreadId,
} from "@spiritdevs/contracts";
import { squashAtomCommandFailure } from "@spiritdevs/client-runtime/state/runtime";
import { AlertTriangleIcon, CheckCircle2Icon, FolderGit2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import { orchestrationEnvironment } from "../../state/orchestration";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
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

const PHASE_LABELS: Record<OrchestrationV2WorkspaceMove["phase"], string> = {
  queued: "Queued",
  stopping_terminals: "Stopping terminal sessions",
  saving_changes: "Saving checkout changes",
  creating_worktree: "Creating the worktree",
  applying_changes: "Applying checkout changes",
  moving_thread: "Moving the thread",
  starting_setup: "Starting the worktree setup action",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ThreadWorkspaceMoveDialogProps {
  open: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  move: OrchestrationV2WorkspaceMove | null | undefined;
  setupScript: ProjectScript | null;
  onOpenChange: (open: boolean) => void;
  onRunSetup: (script: ProjectScript) => void;
}

export function ThreadWorkspaceMoveDialog(props: ThreadWorkspaceMoveDialogProps) {
  const [preview, setPreview] = useState<OrchestrationV2WorkspaceMovePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const move = props.move ?? null;
  const previewMove = useAtomQueryRunner(orchestrationEnvironment.v2.workspaceMovePreview, {
    reportFailure: false,
  });
  const requestMove = useAtomCommand(threadEnvironment.requestWorkspaceMove, {
    reportFailure: false,
  });

  useEffect(() => {
    if (!props.open || props.move?.status === "running") return;
    let active = true;
    setLoading(true);
    setPreview(null);
    setPreviewError(null);
    void previewMove({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }).then((result) => {
      if (!active) return;
      setLoading(false);
      if (AsyncResult.isSuccess(result)) {
        setPreview(result.value);
        return;
      }
      setPreviewError(errorMessage(squashAtomCommandFailure(result)));
    });
    return () => {
      active = false;
    };
  }, [previewMove, props.environmentId, props.move?.status, props.open, props.threadId]);

  const running = move?.status === "running";
  const completed = move?.status === "completed";
  const manualRecovery = move?.status === "manual_recovery";
  const failed = move?.status === "failed" || move?.status === "manual_recovery";
  const blockers = preview?.blockers.filter((blocker) => blocker.kind !== "move_in_progress") ?? [];
  const terminalCount = preview?.terminalCount ?? 0;

  const submit = async () => {
    setPreviewError(null);
    setSubmitting(true);
    try {
      const result = await requestMove({
        environmentId: props.environmentId,
        input: {
          threadId: props.threadId,
          stopTerminals: terminalCount > 0,
        },
      });
      if (!AsyncResult.isSuccess(result)) {
        setPreviewError(errorMessage(squashAtomCommandFailure(result)));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!submitting) props.onOpenChange(open);
      }}
    >
      <DialogPopup className="w-[min(30rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderGit2Icon className="size-5" />
            Move this thread to a worktree
          </DialogTitle>
          <DialogDescription>
            Pathway will save every tracked and untracked change in the project checkout, create a
            worktree from the current commit, and restore those changes there. Ignored files stay in
            the project folder.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-3">
          {running ? (
            <div className="rounded-lg border bg-muted/35 p-3">
              <p className="text-sm font-medium">{move ? PHASE_LABELS[move.phase] : "Queued"}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                You can disconnect or close Pathway. The server will keep working and this thread
                will show the latest state when you reconnect.
              </p>
            </div>
          ) : completed ? (
            <div className="rounded-lg border border-success/30 bg-success/6 p-3">
              <p className="flex items-center gap-2 text-sm font-medium">
                <CheckCircle2Icon className="size-4 text-success" /> Thread moved
              </p>
              {move?.detail ? (
                <p className="mt-2 text-xs text-muted-foreground">{move.detail}</p>
              ) : null}
            </div>
          ) : failed ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/6 p-3">
              <p className="flex items-center gap-2 text-sm font-medium">
                <AlertTriangleIcon className="size-4 text-destructive" />{" "}
                {manualRecovery ? "Manual recovery needed" : "Move failed"}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {move?.detail ?? "The checkout was left unchanged."}
              </p>
            </div>
          ) : loading ? (
            <p className="text-sm text-muted-foreground">Checking the project checkout…</p>
          ) : preview ? (
            <>
              <div className="rounded-lg border bg-muted/35 p-3 text-sm">
                <p>
                  <span className="font-medium">{preview.fileCount}</span> changed or untracked
                  {preview.fileCount === 1 ? " file" : " files"} will move.
                </p>
                {terminalCount > 0 ? (
                  <p className="mt-1 text-muted-foreground">
                    {terminalCount} running terminal {terminalCount === 1 ? "session" : "sessions"}{" "}
                    will be stopped first.
                  </p>
                ) : null}
              </div>
              {blockers.length > 0 ? (
                <div className="rounded-lg border border-warning/30 bg-warning/6 p-3">
                  {blockers.map((blocker) => (
                    <p key={blocker.kind} className="text-sm text-muted-foreground">
                      {blocker.message}
                    </p>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}

          {previewError ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/6 p-3 text-sm text-destructive-foreground">
              {previewError}
            </p>
          ) : null}
        </DialogPanel>

        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={() => props.onOpenChange(false)}>
            {running || completed || failed ? "Close" : "Cancel"}
          </Button>
          {completed && move?.setup === "failed" && props.setupScript ? (
            <Button variant="outline" onClick={() => props.onRunSetup(props.setupScript!)}>
              Run setup again
            </Button>
          ) : null}
          {!completed && !manualRecovery ? (
            <Button
              disabled={loading || submitting || running || preview === null || blockers.length > 0}
              onClick={() => void submit()}
            >
              {running
                ? move
                  ? PHASE_LABELS[move.phase]
                  : "Queued"
                : submitting
                  ? "Starting move…"
                  : failed
                    ? terminalCount > 0
                      ? "Stop terminals and try again"
                      : "Try again"
                    : terminalCount > 0
                      ? "Stop terminals and move"
                      : "Move to worktree"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
