/**
 * The composer's half of an agent mention: the picker that adds one, and the chip that configures
 * it.
 *
 * Neither control writes into the draft. Typing `[Claude](Claude)` is one way to name an agent and
 * the picker is the other, but the picker's choice rides *beside* the text rather than being pasted
 * into it — a composer that rewrote what somebody was mid-sentence on would fight them, and the
 * body is normalized once, at submit.
 *
 * The chip's popover is the same composition Start work uses: a `ProviderModelPicker` for the
 * instance and model, and a `TraitsPicker` for whatever option descriptors that model exposes
 * (reasoning effort, service tier). Deliberately the same, because "which agent, on what model,
 * with what effort" is one question and it should not have two answers in one product.
 *
 * @module components/issues/IssueCommentMentionControls
 */
import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { AtSignIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { ProviderInstanceEntry } from "~/providerInstances";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import type { ModelEsque } from "../chat/providerIconUtils";
import { shouldRenderTraitsControls, TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  issueCommentMentionModelSummary,
  type IssueCommentMentionAgent,
} from "./issueCommentMention.logic";

const ignorePromptChange = (_prompt: string): void => undefined;

/** The instance entries a mention may name: configured, enabled, and actually runnable. */
export function issueCommentMentionAgents(
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<IssueCommentMentionAgent> {
  return entries
    .filter((entry) => entry.enabled && entry.isAvailable && entry.installed)
    .map((entry) => ({
      instanceId: entry.instanceId,
      provider: entry.driverKind,
      displayName: entry.displayName,
    }));
}

/** The "@" button beside Attach. Silent when nothing is configured: there is nobody to mention. */
export function IssueCommentMentionPicker({
  agents,
  entries,
  disabled,
  onPick,
}: {
  agents: ReadonlyArray<IssueCommentMentionAgent>;
  entries: ReadonlyArray<ProviderInstanceEntry>;
  disabled?: boolean;
  onPick: (instanceId: ProviderInstanceId) => void;
}) {
  if (agents.length === 0) return null;
  const entryById = new Map(entries.map((entry) => [entry.instanceId, entry]));

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-label="Mention an agent"
            className="text-muted-foreground"
            disabled={disabled}
            size="icon-xs"
            title="Mention an agent"
            variant="ghost"
          />
        }
      >
        <AtSignIcon />
      </MenuTrigger>
      <MenuPopup align="start" className="w-60" side="top">
        {agents.map((agent) => {
          const entry = entryById.get(agent.instanceId);
          return (
            <MenuItem key={agent.instanceId} onClick={() => onPick(agent.instanceId)}>
              <ProviderInstanceIcon
                accentColor={entry?.accentColor}
                className="size-4"
                displayName={agent.displayName}
                driverKind={agent.provider}
              />
              <span className="min-w-0 truncate">{agent.displayName}</span>
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}

/**
 * The active mention, beside the textarea. Clicking it opens the configuration; the X drops the
 * mention without touching a character of the draft.
 */
export function IssueCommentMentionChip({
  agent,
  entries,
  modelOptionsByInstance,
  modelSelection,
  disabled,
  onModelSelectionChange,
  onRemove,
}: {
  agent: IssueCommentMentionAgent;
  entries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  modelSelection: ModelSelection | null;
  disabled?: boolean;
  onModelSelectionChange: (selection: ModelSelection) => void;
  onRemove: () => void;
}) {
  const activeEntry =
    entries.find(
      (entry) => entry.instanceId === (modelSelection?.instanceId ?? agent.instanceId),
    ) ?? null;
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
  const summary =
    modelSelection === null
      ? "No model available"
      : issueCommentMentionModelSummary(modelSelection);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center rounded-full border border-primary/25 bg-primary/10 ps-1 pe-0.5 py-px text-primary">
        <Popover>
          <PopoverTrigger
            render={
              <button
                aria-label={`Configure the ${agent.displayName} mention`}
                className="flex min-w-0 items-center gap-1.5 rounded-full px-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
                disabled={disabled}
                type="button"
              />
            }
          >
            <ProviderInstanceIcon
              accentColor={activeEntry?.accentColor}
              className="size-3.5 shrink-0"
              displayName={agent.displayName}
              driverKind={agent.provider}
            />
            <span className="min-w-0 truncate font-medium">{agent.displayName}</span>
            <span className="min-w-0 truncate text-primary/70">{summary}</span>
          </PopoverTrigger>
          <PopoverPopup align="start" className="w-80" side="top">
            <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5">
              <span className="text-[11px] text-muted-foreground">Model</span>
              {modelSelection === null || activeEntry === null ? (
                <span className="text-[11px] text-muted-foreground">
                  No configured model can answer this mention.
                </span>
              ) : (
                <ProviderModelPicker
                  activeInstanceId={modelSelection.instanceId}
                  instanceEntries={entries}
                  lockedProvider={null}
                  model={modelSelection.model}
                  modelOptionsByInstance={modelOptionsByInstance}
                  onInstanceModelChange={(instanceId, model) => {
                    onModelSelectionChange(createModelSelection(instanceId, model));
                  }}
                  triggerAriaLabel={`Model for the ${agent.displayName} mention`}
                  triggerClassName="w-full max-w-none shrink text-foreground/90 hover:text-foreground"
                  triggerVariant="outline"
                />
              )}

              {hasTraits && modelSelection !== null && activeEntry !== null ? (
                <>
                  <span className="text-[11px] text-muted-foreground">Reasoning</span>
                  <div
                    aria-label={`Reasoning and model options for the ${agent.displayName} mention`}
                  >
                    <TraitsPicker
                      allowPromptInjectedEffort={false}
                      model={modelSelection.model}
                      modelOptions={modelSelection.options}
                      models={activeEntry.models}
                      onModelOptionsChange={(nextOptions) => {
                        onModelSelectionChange(
                          createModelSelection(
                            modelSelection.instanceId,
                            modelSelection.model,
                            nextOptions,
                          ),
                        );
                      }}
                      onPromptChange={ignorePromptChange}
                      prompt=""
                      provider={activeEntry.driverKind}
                      triggerClassName="w-full max-w-none shrink justify-between text-foreground/90 hover:text-foreground"
                      triggerVariant="outline"
                    />
                  </div>
                </>
              ) : null}
            </div>
          </PopoverPopup>
        </Popover>
        <button
          aria-label={`Remove the ${agent.displayName} mention`}
          className={cn(
            "ms-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full",
            "text-primary/70 outline-none hover:bg-primary/15 hover:text-primary",
            "focus-visible:ring-2 focus-visible:ring-ring",
          )}
          onClick={onRemove}
          type="button"
        >
          <XIcon className="size-3" />
        </button>
      </span>
    </div>
  );
}
