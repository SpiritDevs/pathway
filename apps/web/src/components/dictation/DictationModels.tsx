import { CheckIcon, DownloadIcon, HardDriveIcon, SparklesIcon } from "lucide-react";
import type { DictationModelState } from "@spiritdevs/contracts/dictation";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { ConfirmDelete, Notice, ReadinessNotice, type DictationActions } from "./DictationControls";
import { formatBytes } from "./dictationUi";

const descriptions = {
  "whisper-base": "The smallest download in the speech catalog. Supports multiple languages.",
  "whisper-small": "A smaller alternative to Turbo, with multilingual recognition.",
  "whisper-turbo": "Recommended for everyday dictation, with multilingual recognition.",
  "qwen-cleanup":
    "Removes fillers, repetitions, and spoken corrections while preserving your meaning and language.",
};

export function DictationModelCard({
  model,
  state,
  execute,
  updatePreferences,
}: DictationActions & { model: DictationModelState }) {
  const selected = model.kind === "speech" && state.preferences.speechModel === model.id;
  const downloading = model.status === "downloading" || model.status === "verifying";
  const progress = Math.min(
    100,
    Math.max(0, model.bytes > 0 ? (model.downloadedBytes / model.bytes) * 100 : 0),
  );
  const inUse = ["starting", "recording", "processing"].includes(state.phase);
  return (
    <article
      className={`rounded-2xl border p-5 ${selected ? "border-primary/30 bg-primary/[0.025]" : "border-border/70 bg-muted/10"}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{model.name}</h3>
            {model.id === "whisper-turbo" && (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                Recommended
              </span>
            )}
          </div>
          <p className="max-w-lg text-[13px] leading-relaxed text-muted-foreground">
            {descriptions[model.id]}
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-muted-foreground">
            <span>{formatBytes(model.bytes)}</span>
            {model.status === "installed" && (
              <span className="inline-flex items-center gap-1">
                <CheckIcon className="size-3" />
                Downloaded
              </span>
            )}
            {model.loaded && (
              <span className="inline-flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                Loaded in memory
              </span>
            )}
            {selected && <span className="font-medium text-primary">Selected speech model</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {model.status === "installed" ? (
            <>
              {model.kind === "speech" && !selected && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={inUse}
                  onClick={() => void updatePreferences({ speechModel: model.id })}
                >
                  Use model
                </Button>
              )}
              <ConfirmDelete
                label="Remove model"
                disabled={inUse}
                onConfirm={() => void execute({ type: "remove-model", modelId: model.id })}
              />
            </>
          ) : downloading ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void execute({ type: "cancel-download", modelId: model.id })}
            >
              Cancel download
            </Button>
          ) : (
            <Button
              size="sm"
              variant={model.id === "whisper-turbo" ? "default" : "outline"}
              onClick={() => void execute({ type: "download", modelId: model.id })}
            >
              <DownloadIcon />
              {model.status === "error" ? "Retry download" : "Download"}
            </Button>
          )}
        </div>
      </div>
      {downloading && (
        <div className="mt-4 space-y-2">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>
              {model.status === "verifying"
                ? "Verifying download…"
                : `${formatBytes(model.downloadedBytes)} of ${formatBytes(model.bytes)}`}
            </span>
            <span className="tabular-nums">{Math.round(progress)}%</span>
          </div>
          <div
            role="progressbar"
            aria-label={`${model.name} download`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress)}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}
      {model.error && (
        <p role="alert" className="mt-3 text-xs text-destructive-foreground">
          {model.error}
        </p>
      )}
      {selected && model.status === "installed" && (
        <p className="mt-3 text-xs text-muted-foreground">
          Removing this model makes recording unavailable until you select another downloaded speech
          model.
        </p>
      )}
    </article>
  );
}

export function DictationModels(props: DictationActions) {
  const { state, updatePreferences } = props;
  const cleanup = state.models.find((model) => model.kind === "cleanup");
  return (
    <>
      <ReadinessNotice state={state} />
      <SettingsSection
        title="Speech models"
        id="dictation-models"
        icon={<HardDriveIcon className="size-4" />}
      >
        <p className="px-4 pb-3 text-[13px] text-muted-foreground">
          Downloaded to this desktop. Models load when you record and can be removed at any time.
        </p>
        <div className="space-y-3">
          {state.models
            .filter((model) => model.kind === "speech")
            .map((model) => (
              <DictationModelCard key={model.id} model={model} {...props} />
            ))}
        </div>
      </SettingsSection>
      <SettingsSection
        title="Text cleanup"
        id="dictation-cleanup"
        icon={<SparklesIcon className="size-4" />}
      >
        <SettingsRow
          title="Clean up dictation"
          description="Keep the words you meant to say. You can always inspect the original transcript in History."
          control={
            <Switch
              aria-label="Clean up dictation"
              checked={state.preferences.cleanupEnabled}
              onCheckedChange={(cleanupEnabled) => void updatePreferences({ cleanupEnabled })}
            />
          }
        />
        {cleanup && <DictationModelCard model={cleanup} {...props} />}
        {state.preferences.cleanupEnabled && cleanup?.status !== "installed" && (
          <Notice>Until the cleanup model is ready, dictation delivers the recognized text.</Notice>
        )}
      </SettingsSection>
    </>
  );
}
