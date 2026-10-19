import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityIcon,
  ArrowRightIcon,
  CheckIcon,
  DownloadIcon,
  MicIcon,
  ShieldCheckIcon,
} from "lucide-react";
import type { DictationState } from "@spiritdevs/contracts/dictation";
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
import { WizardSteps } from "../ui/wizard-steps";
import { SettingsSurfaceProvider } from "../settings/settingsLayout";
import {
  MicrophoneControls,
  Notice,
  ShortcutControls,
  type DictationActions,
} from "./DictationControls";
import { formatBytes } from "./dictationUi";
import {
  dictationPermissionCommand,
  dictationSetupAccessReady,
  dictationSetupCanFinish,
  dictationSetupCanVisit,
  dictationSetupInitialStep,
  dictationSetupModels,
  dictationSetupModelsReady,
  dictationSetupSteps,
  type DictationSetupStep,
} from "./DictationSetupDialog.logic";

function PermissionRow({
  title,
  description,
  granted,
  denied,
  busy,
  icon,
  onAllow,
}: {
  title: string;
  description: string;
  granted: boolean;
  denied: boolean;
  busy: boolean;
  icon: ReactNode;
  onAllow: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-muted/10 p-4">
      {icon}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {granted ? (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-success">
          <CheckIcon className="size-4" />
          Allowed
        </span>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          aria-label={`Allow ${title.toLowerCase()}`}
          onClick={onAllow}
        >
          {denied ? "Open settings" : "Allow"}
        </Button>
      )}
    </div>
  );
}

export function DictationSetupDialog({
  state,
  execute,
  updatePreferences,
  onClose,
  error,
  initialStep,
}: DictationActions & {
  onClose: () => void;
  error?: string | null;
  initialStep?: DictationSetupStep;
}) {
  const [step, setStep] = useState(() => dictationSetupInitialStep(state, initialStep));
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [requestedPermission, setRequestedPermission] = useState<
    "microphone" | "accessibility" | null
  >(null);
  const [startingDownloads, setStartingDownloads] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(
    async (action: () => Promise<DictationState | null>, fallback: string) => {
      if (busyRef.current) return null;
      busyRef.current = true;
      setBusy(true);
      setActionError(null);
      try {
        const next = await action();
        if (!mounted.current) return null;
        if (mounted.current && !next) setActionError(fallback);
        return next;
      } catch (cause) {
        if (mounted.current) setActionError(cause instanceof Error ? cause.message : fallback);
        return null;
      } finally {
        busyRef.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [],
  );
  const refresh = useCallback(async () => {
    const next = await run(
      () => execute(dictationPermissionCommand("refresh")),
      "Could not check permissions. Try again.",
    );
    if (mounted.current && next) setChecked(true);
    return next;
  }, [execute, run]);
  useEffect(() => {
    void refresh();
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const mac = state.platform === "darwin";
  const accessReady = dictationSetupAccessReady(state);
  const models = dictationSetupModels(state);
  const modelsReady = dictationSetupModelsReady(state);
  const downloading = models.some(
    (model) => model.status === "downloading" || model.status === "verifying",
  );
  const remaining = models.filter(
    (model) => model.status === "missing" || model.status === "error",
  );
  const captureBusy = ["starting", "recording", "processing"].includes(state.phase);
  const stepIndex = dictationSetupSteps.findIndex((item) => item.id === step);
  const permission = async (action: "microphone" | "accessibility") => {
    setRequestedPermission(action);
    setChecked(false);
    await run(
      () => execute(dictationPermissionCommand(action)),
      `Could not request ${action} access. Try again.`,
    );
  };
  const close = async () => {
    if (busyRef.current) return;
    if (state.mode === "test" && (captureBusy || state.result?.delivery === "test")) {
      const next = await run(
        () => execute({ type: captureBusy ? "cancel" : "dismiss" }),
        "Could not stop the microphone test. Try again.",
      );
      if (!next) return;
    }
    onClose();
  };
  const next = async () => {
    if (step === "access") {
      const checkedState = await refresh();
      if (checkedState && dictationSetupAccessReady(checkedState)) setStep("models");
      return;
    }
    if (step === "models" && accessReady && modelsReady) {
      const updated = await run(
        () => updatePreferences({ speechModel: "whisper-turbo" }),
        "Could not select your speech model. Try again.",
      );
      if (updated) setStep("test");
      return;
    }
    if (step === "test" && dictationSetupCanFinish(state)) {
      const updated = await run(async () => {
        const current = await execute(dictationPermissionCommand("refresh"));
        if (
          !mounted.current ||
          !current ||
          current.accountId !== state.accountId ||
          !dictationSetupCanFinish(current)
        )
          return null;
        if (current.result?.delivery === "test") {
          if (!(await execute({ type: "dismiss" })) || !mounted.current) return null;
        }
        return updatePreferences({ enabled: true, setupComplete: true });
      }, "Dictation is not ready yet. Check permissions and your microphone, then try again.");
      if (updated?.preferences.setupComplete && updated.preferences.enabled) onClose();
    }
  };
  const download = async () => {
    if (startingDownloads || !accessReady) return;
    setStartingDownloads(true);
    setActionError(null);
    // Individual model updates own progress and cancellation; do not block the dialog for a download.
    const results = await Promise.allSettled(
      remaining.map((model) => execute({ type: "download", modelId: model.id })),
    );
    if (!mounted.current) return;
    setStartingDownloads(false);
    if (results.some((result) => result.status === "rejected" || result.value === null))
      setActionError("A model could not be downloaded. Retry the download below.");
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogPopup
        className="max-w-2xl"
        showCloseButton={!busy}
        onKeyDown={(event) => {
          if (event.key === "Escape") event.stopPropagation();
        }}
      >
        <DialogHeader className="gap-5">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl border border-primary/15 bg-primary/5 text-primary">
              <MicIcon className="size-5" />
            </div>
            <div>
              <DialogTitle>Set up dictation</DialogTitle>
              <p className="mt-1.5 text-xs text-muted-foreground">On this desktop, in any app.</p>
            </div>
          </div>
          <WizardSteps
            steps={dictationSetupSteps.map((item, index) => ({
              ...item,
              disabled: index > stepIndex || !dictationSetupCanVisit(state, item.id),
            }))}
            currentStep={step}
            disabled={busy || captureBusy}
            onStepSelect={setStep}
          />
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-5 text-sm">
            <div className="space-y-2">
              <h3 className="text-base font-semibold tracking-tight">
                {step === "access"
                  ? "Allow dictation on your desktop"
                  : step === "models"
                    ? "Download your dictation models"
                    : "Try your voice"}
              </h3>
              <DialogDescription>
                {step === "access"
                  ? mac
                    ? "Allow microphone access, then add Pathway to Accessibility in System Settings."
                    : "Allow Pathway to use your microphone. Turn on microphone access for desktop apps if Windows asks."
                  : step === "models"
                    ? "Speech recognition turns your voice into text. Cleanup removes fillers and spoken corrections. Both run on this desktop."
                    : "Choose your microphone and shortcut, then record a short phrase. Your test stays here and never changes your clipboard."}
              </DialogDescription>
            </div>
            {step === "access" && (
              <>
                <div className="space-y-3">
                  <PermissionRow
                    title="Microphone"
                    description="Hear your voice while you record or run a test."
                    granted={state.microphonePermission === "granted"}
                    denied={state.microphonePermission === "denied"}
                    busy={busy}
                    onAllow={() => void permission("microphone")}
                    icon={
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-rose-500 text-white shadow-sm">
                        <MicIcon className="size-5" />
                      </div>
                    }
                  />
                  {mac && (
                    <PermissionRow
                      title="Accessibility"
                      description="Use your recording shortcut and insert text into other apps."
                      granted={state.accessibilityPermission === "granted"}
                      denied={state.accessibilityPermission === "denied"}
                      busy={busy}
                      onAllow={() => void permission("accessibility")}
                      icon={
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-blue-500 text-white shadow-sm">
                          <AccessibilityIcon className="size-6" />
                        </div>
                      }
                    />
                  )}
                </div>
                {mac && state.accessibilityPermission !== "granted" && (
                  <div className="rounded-xl border border-border/60 bg-muted/25 p-4">
                    <p className="mb-2 text-xs font-medium">
                      Allow Accessibility in System Settings
                    </p>
                    <ol className="list-decimal space-y-1.5 pl-4 text-xs leading-relaxed text-muted-foreground">
                      <li>Open Accessibility using the button above.</li>
                      <li>
                        Drag the Pathway app from the permission window into the Accessibility list.
                      </li>
                      <li>Turn on Pathway's switch, then return here.</li>
                    </ol>
                  </div>
                )}
                {!mac && state.microphonePermission === "denied" && (
                  <Notice>
                    In Windows Settings, open Privacy &amp; security → Microphone. Turn on
                    microphone access and access for desktop apps, then return to Pathway.
                  </Notice>
                )}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p role="status" className="text-xs text-muted-foreground">
                    {busy
                      ? "Checking permissions…"
                      : accessReady
                        ? "Permissions are ready. Continue to your models."
                        : requestedPermission === "accessibility" && mac
                          ? "Return here after turning on Pathway in System Settings."
                          : checked
                            ? "Still waiting for permission. Allow access, then check again."
                            : "Permissions update when you return to Pathway."}
                  </p>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
                    Check again
                  </Button>
                </div>
                {!state.nativeAvailable && (
                  <Notice error>
                    The dictation engine is unavailable in this build. Restart Pathway to check
                    again.
                  </Notice>
                )}
              </>
            )}
            {step === "models" && (
              <>
                <div className="space-y-3">
                  {models.map((model) => {
                    const progress = Math.min(
                      100,
                      Math.max(
                        0,
                        model.bytes > 0 ? (model.downloadedBytes / model.bytes) * 100 : 0,
                      ),
                    );
                    const active = model.status === "downloading" || model.status === "verifying";
                    return (
                      <article key={model.id} className="rounded-xl border border-border/70 p-4">
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                              {model.kind === "speech" ? "Speech recognition" : "Text cleanup"}
                            </p>
                            <h4 className="mt-1 text-sm font-semibold">{model.name}</h4>
                            <p className="mt-1.5 text-xs text-muted-foreground">
                              {formatBytes(model.bytes)}
                              {model.kind === "speech"
                                ? " · Recommended"
                                : " · Preserves your language"}
                            </p>
                          </div>
                          {model.status === "installed" ? (
                            <span className="flex items-center gap-1 text-xs text-success">
                              <CheckIcon className="size-4" />
                              Downloaded
                            </span>
                          ) : active ? (
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() =>
                                void execute({ type: "cancel-download", modelId: model.id })
                              }
                            >
                              Cancel
                            </Button>
                          ) : (
                            <DownloadIcon className="size-4 text-muted-foreground" />
                          )}
                        </div>
                        {active && (
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
                              aria-valuenow={Math.round(progress)}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              className="h-1.5 overflow-hidden rounded-full bg-muted"
                            >
                              <div
                                className="h-full rounded-full bg-primary"
                                style={{ width: `${progress}%` }}
                              />
                            </div>
                          </div>
                        )}
                        {model.error && (
                          <p className="mt-3 text-xs text-destructive-foreground" role="alert">
                            {model.error}
                          </p>
                        )}
                      </article>
                    );
                  })}
                </div>
                {modelsReady ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <CheckIcon className="size-4 text-success" />
                    Your models are already downloaded. No download needed.
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {formatBytes(models.reduce((total, model) => total + model.bytes, 0))} total.
                      Downloads can continue if you finish later.
                    </p>
                    <Button
                      size="sm"
                      disabled={remaining.length === 0 || startingDownloads || !accessReady}
                      onClick={() => download()}
                    >
                      <DownloadIcon />
                      {models.some((model) => model.status === "error")
                        ? "Retry download"
                        : "Download models"}
                    </Button>
                  </div>
                )}
              </>
            )}
            {step === "test" && (
              <SettingsSurfaceProvider surface="sheet">
                <div className="@container/settings space-y-5">
                  <MicrophoneControls
                    state={state}
                    execute={execute}
                    updatePreferences={updatePreferences}
                  />
                  <ShortcutControls
                    state={state}
                    execute={execute}
                    updatePreferences={updatePreferences}
                  />
                </div>
                <div className="flex gap-2 rounded-xl bg-muted/25 p-4 text-xs leading-relaxed text-muted-foreground">
                  <ShieldCheckIcon className="mt-0.5 size-4 shrink-0" />
                  <p>
                    Hold your shortcut to record. Double-tap for locked recording. Your test is
                    optional; enable dictation when you are ready.
                  </p>
                </div>
              </SettingsSurfaceProvider>
            )}
            {step !== "access" && !accessReady && (
              <Notice error>Permission changed. Go back to Access to allow dictation.</Notice>
            )}
            {step === "test" && !modelsReady && (
              <Notice error>
                Your models are not ready. Go back to Models to finish downloading.
              </Notice>
            )}
            {(actionError || error || state.error) && (
              <Notice error>{error ?? state.error ?? actionError}</Notice>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          {stepIndex > 0 && (
            <Button
              variant="ghost"
              disabled={busy || captureBusy}
              onClick={() => setStep(dictationSetupSteps[stepIndex - 1]!.id)}
            >
              Back
            </Button>
          )}
          <Button variant="ghost" disabled={busy} onClick={() => close()}>
            Finish later
          </Button>
          <Button
            disabled={
              busy ||
              captureBusy ||
              (step === "access"
                ? !accessReady
                : step === "models"
                  ? !accessReady || !modelsReady
                  : !dictationSetupCanFinish(state))
            }
            onClick={() => next()}
          >
            {busy
              ? "Checking…"
              : step === "test"
                ? "Enable dictation"
                : step === "models" && downloading
                  ? "Downloading…"
                  : "Continue"}
            {!busy && step !== "test" && <ArrowRightIcon className="size-4" />}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
