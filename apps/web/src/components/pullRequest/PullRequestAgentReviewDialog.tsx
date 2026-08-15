import type { ModelSelection, ProviderInstanceId } from "@spiritdevs/contracts";
import { createModelSelection } from "@spiritdevs/shared/model";
import { BotIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { ProviderInstanceEntry } from "~/providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import type { ModelEsque } from "../chat/providerIconUtils";
import { shouldRenderTraitsControls, TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";

const ignorePromptChange = (_prompt: string): void => undefined;

export function PullRequestAgentReviewDialog({
  open,
  initialModelSelection,
  instanceEntries,
  modelOptionsByInstance,
  canPublishComments,
  starting,
  onOpenChange,
  onStart,
}: {
  readonly open: boolean;
  readonly initialModelSelection: ModelSelection | null;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly canPublishComments: boolean;
  readonly starting: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onStart: (input: {
    readonly modelSelection: ModelSelection;
    readonly instructions: string;
    readonly publishComments: boolean;
  }) => void;
}) {
  const [modelSelection, setModelSelection] = useState(initialModelSelection);
  const [instructions, setInstructions] = useState("");
  const [publishComments, setPublishComments] = useState(canPublishComments);

  useEffect(() => {
    if (!open) return;
    setModelSelection(initialModelSelection);
    setInstructions("");
    setPublishComments(canPublishComments);
  }, [canPublishComments, initialModelSelection, open]);

  const activeEntry =
    instanceEntries.find((entry) => entry.instanceId === modelSelection?.instanceId) ?? null;
  const hasTraits =
    activeEntry !== null &&
    modelSelection !== null &&
    shouldRenderTraitsControls({
      provider: activeEntry.driverKind,
      models: activeEntry.models,
      model: modelSelection.model,
      prompt: "",
      modelOptions: modelSelection.options,
      allowPromptInjectedEffort: false,
    });
  const blocked = modelSelection === null || activeEntry === null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!starting) onOpenChange(nextOpen);
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BotIcon className="size-4" />
            Review with an agent
          </DialogTitle>
          <DialogDescription>
            The review runs in its own worktree and stays attached to this pull request.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {modelSelection !== null && activeEntry !== null ? (
            <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
              <span className="text-xs text-muted-foreground">Agent</span>
              <ProviderModelPicker
                activeInstanceId={modelSelection.instanceId}
                disabled={starting}
                instanceEntries={instanceEntries}
                lockedProvider={null}
                model={modelSelection.model}
                modelOptionsByInstance={modelOptionsByInstance}
                onInstanceModelChange={(instanceId, model) =>
                  setModelSelection(createModelSelection(instanceId, model))
                }
                triggerAriaLabel="Agent and model for pull request review"
                triggerClassName="w-full max-w-none shrink text-foreground/90 hover:text-foreground"
                triggerVariant="outline"
              />

              {hasTraits ? (
                <>
                  <span className="text-xs text-muted-foreground">Options</span>
                  <TraitsPicker
                    allowPromptInjectedEffort={false}
                    model={modelSelection.model}
                    modelOptions={modelSelection.options}
                    models={activeEntry.models}
                    onModelOptionsChange={(nextOptions) =>
                      setModelSelection((current) =>
                        current === null
                          ? null
                          : createModelSelection(current.instanceId, current.model, nextOptions),
                      )
                    }
                    onPromptChange={ignorePromptChange}
                    prompt=""
                    provider={activeEntry.driverKind}
                    triggerClassName="w-full max-w-none shrink justify-between text-foreground/90 hover:text-foreground"
                    triggerVariant="outline"
                  />
                </>
              ) : null}
            </div>
          ) : (
            <p className="rounded-lg border border-border/70 bg-muted/25 p-3 text-sm text-muted-foreground">
              No configured agent is currently available for this review.
            </p>
          )}

          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Review focus (optional)</span>
            <Textarea
              aria-label="Additional pull request review instructions"
              disabled={starting}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="For example: focus on the migration and backwards compatibility."
              rows={3}
              value={instructions}
            />
          </label>

          <label className="flex items-start gap-2.5 rounded-lg border border-border/70 p-3">
            <Checkbox
              checked={publishComments}
              disabled={starting || !canPublishComments}
              onCheckedChange={(checked) => setPublishComments(checked === true)}
            />
            <span className="flex min-w-0 flex-col text-sm">
              <span className="font-medium">Publish inline findings</span>
              <span className="text-xs leading-relaxed text-muted-foreground">
                {canPublishComments
                  ? "Post the agent's findings as review comments. Turn this off to keep them as drafts in Code."
                  : "This source-control host cannot publish inline review comments from Pathway."}
              </span>
            </span>
          </label>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={starting} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={starting || blocked}
            onClick={() => {
              if (modelSelection === null) return;
              onStart({ modelSelection, instructions, publishComments });
            }}
          >
            {starting ? <Spinner className="size-3.5" /> : <BotIcon className="size-3.5" />}
            {starting ? "Preparing review…" : "Start review"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
