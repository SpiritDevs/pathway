import type {
  ModelSelection,
  ProviderInstanceId,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { GitForkIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { ProviderModelPicker } from "./ProviderModelPicker";
import type { ModelEsque } from "./providerIconUtils";
import { resolveInitialContinuationSelection } from "./ContinuationDialog.logic";

export type ContinuationWorkspaceTarget = "current" | "new-worktree";

export function ContinuationDialog(props: {
  readonly open: boolean;
  readonly kind: "continue" | "handoff";
  readonly sourceModelSelection: ModelSelection;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly keybindings?: ResolvedKeybindingsConfig;
  readonly canCreateWorktree: boolean;
  readonly pending: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (
    modelSelection: ModelSelection,
    workspaceTarget: ContinuationWorkspaceTarget,
  ) => void;
}) {
  const initialSelection = useMemo(
    () =>
      resolveInitialContinuationSelection({
        kind: props.kind,
        source: props.sourceModelSelection,
        instanceEntries: props.instanceEntries,
        modelOptionsByInstance: props.modelOptionsByInstance,
      }),
    [props.instanceEntries, props.kind, props.modelOptionsByInstance, props.sourceModelSelection],
  );
  const [selection, setSelection] = useState(props.sourceModelSelection);
  const availableInstanceEntries = useMemo(
    () =>
      props.kind === "handoff"
        ? props.instanceEntries.filter(
            (entry) => entry.instanceId !== props.sourceModelSelection.instanceId,
          )
        : props.instanceEntries,
    [props.instanceEntries, props.kind, props.sourceModelSelection.instanceId],
  );
  useEffect(() => {
    if (props.open) setSelection(initialSelection ?? props.sourceModelSelection);
  }, [initialSelection, props.open, props.sourceModelSelection]);
  const handoffUnavailable = props.kind === "handoff" && initialSelection === null;
  const handoffStillOnSource =
    props.kind === "handoff" && selection.instanceId === props.sourceModelSelection.instanceId;

  return (
    <Dialog open={props.open} onOpenChange={(open) => !props.pending && props.onOpenChange(open)}>
      <DialogPopup className="w-[min(28rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>
            {props.kind === "handoff" ? "Hand off this chat" : "Continue in a new chat"}
          </DialogTitle>
          <DialogDescription>
            {props.kind === "handoff"
              ? "Choose another provider or account for the next response."
              : "Start from this response and choose the model and checkout."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 px-6 pb-6">
          <ProviderModelPicker
            activeInstanceId={selection.instanceId}
            model={selection.model}
            lockedProvider={null}
            instanceEntries={availableInstanceEntries}
            modelOptionsByInstance={props.modelOptionsByInstance}
            {...(props.keybindings ? { keybindings: props.keybindings } : {})}
            disabled={props.pending}
            triggerVariant="outline"
            triggerClassName="w-full max-w-none"
            triggerAriaLabel="Continuation model"
            onInstanceModelChange={(instanceId, model) => setSelection({ instanceId, model })}
          />
          {handoffUnavailable ? (
            <p className="text-sm text-muted-foreground">No other provider instance is ready.</p>
          ) : null}
          {props.kind === "handoff" ? (
            <Button
              className="w-full"
              disabled={props.pending || handoffUnavailable || handoffStillOnSource}
              onClick={() => props.onSubmit(selection, "current")}
            >
              {props.pending ? <Spinner className="size-4" /> : null}
              {props.pending ? "Handing off…" : "Hand off"}
            </Button>
          ) : (
            <div className="grid gap-2">
              <ContinuationChoice
                title="Use this worktree"
                description="Continue in the current checkout"
                pending={props.pending}
                onClick={() => props.onSubmit(selection, "current")}
              />
              {props.canCreateWorktree ? (
                <ContinuationChoice
                  title="Use a new worktree"
                  description="Start from the source checkout's committed HEAD"
                  pending={props.pending}
                  onClick={() => props.onSubmit(selection, "new-worktree")}
                />
              ) : null}
            </div>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function ContinuationChoice(props: {
  readonly title: string;
  readonly description: string;
  readonly pending: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.pending}
      onClick={props.onClick}
      className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-border px-3 py-2 text-left transition-colors hover:bg-accent disabled:opacity-50"
    >
      {props.pending ? <Spinner className="size-4" /> : <GitForkIcon className="size-4" />}
      <span>
        <span className="block text-sm font-medium">{props.title}</span>
        <span className="block text-xs text-muted-foreground">{props.description}</span>
      </span>
    </button>
  );
}
