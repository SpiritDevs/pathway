import { useState } from "react";
import { type StoragePolicy } from "@spiritdevs/contracts";
import { squashAtomCommandFailure } from "@spiritdevs/client-runtime/state/runtime";

import { useClientSettings } from "../../hooks/useSettings";
import type { StorageEnvironmentEntry } from "../../lib/storageDashboardState";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
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
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";

export function StoragePolicyDialog({
  entry,
  selectedEntries,
  defaultPolicy,
  onSaveDefault,
  onClose,
  onSaved,
}: {
  entry: StorageEnvironmentEntry | null;
  defaultPolicy: StoragePolicy;
  onSaveDefault: (policy: StoragePolicy) => void;
  selectedEntries: ReadonlyArray<StorageEnvironmentEntry>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const settings = useClientSettings();
  const [policy, setPolicy] = useState<StoragePolicy>(entry?.snapshot?.policy ?? defaultPolicy);
  const [applyToSelected, setApplyToSelected] = useState(false);
  const [isSaving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savePolicy = useAtomCommand(serverEnvironment.storageSetPolicy);
  const invalidThresholds =
    policy.warningBytes <= policy.criticalBytes || policy.warningPercent <= policy.criticalPercent;
  const set = <K extends keyof StoragePolicy>(key: K, value: StoragePolicy[K]) =>
    setPolicy((previous) => ({ ...previous, [key]: value }));
  const save = async () => {
    setSaving(true);
    setError(null);
    const effectivePolicy = { ...policy, autoSettleAfterDays: settings.sidebarAutoSettleAfterDays };
    if (!entry) {
      try {
        onSaveDefault(effectivePolicy);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "Could not save defaults.");
        setSaving(false);
        return;
      }
    }
    const targets = applyToSelected ? selectedEntries : entry ? [entry] : [];
    const failures: string[] = [];
    await Promise.all(
      targets.map(async ({ environment }) => {
        if (environment.connection.phase !== "connected") {
          failures.push(`${environment.label}: offline, no changes were queued.`);
          return;
        }
        const result = await savePolicy({
          environmentId: environment.environmentId,
          input: { policy: effectivePolicy },
        });
        if (result._tag === "Failure") {
          const reason = squashAtomCommandFailure(result);
          failures.push(
            `${environment.label}: ${reason instanceof Error ? reason.message : "Could not save policy."}`,
          );
        }
      }),
    );
    setSaving(false);
    onSaved();
    if (failures.length) setError(failures.join(" "));
    else onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSaving) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{entry ? "Cleanup policy" : "Cleanup defaults"}</DialogTitle>
          <DialogDescription>
            {entry
              ? `${entry.environment.label} monitors storage even when this dashboard is closed.`
              : "Save a reusable policy for this account on this client. Environments only use these defaults after you apply them."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-6">
          {entry && (
            <Button
              size="sm"
              variant="outline"
              disabled={isSaving}
              onClick={() => setPolicy(defaultPolicy)}
            >
              Use saved defaults
            </Button>
          )}
          <div className="flex items-start justify-between gap-4">
            <div>
              <label htmlFor="storage-scheduled" className="text-sm font-medium">
                Scheduled worktree cleanup
              </label>
              <p className="mt-1 text-xs text-muted-foreground">
                Remove eligible worktrees after they stay archived or settled. Uses your
                inactive-thread setting to detect settled threads.
              </p>
            </div>
            <Switch
              id="storage-scheduled"
              checked={policy.enabled}
              onCheckedChange={(value) => set("enabled", value)}
              disabled={isSaving}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <label htmlFor="storage-age" className="text-sm">
              Clean up after
            </label>
            <Select
              value={policy.afterDays}
              onValueChange={(value) => {
                if (value === 7 || value === 14 || value === 30 || value === 60)
                  set("afterDays", value);
              }}
              disabled={isSaving}
            >
              <SelectTrigger id="storage-age" className="w-36">
                <SelectValue>{policy.afterDays} days</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {([7, 14, 30, 60] as const).map((days) => (
                  <SelectItem key={days} value={days}>
                    {days} days
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <p className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs leading-relaxed">
            Cleanup deletes the entire worktree, including ignored files such as local configuration
            and databases. Conversation history and the branch are kept. Use Keep worktree to
            protect a folder.
          </p>
          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-medium">Available storage thresholds</legend>
            <p className="text-xs text-muted-foreground">
              A warning appears when either limit is crossed. Critical storage never starts
              emergency cleanup automatically.
            </p>
            <div className="grid grid-cols-[1fr_6rem_6rem] items-center gap-3 text-xs">
              <span />
              <span className="text-muted-foreground">GB available</span>
              <span className="text-muted-foreground">% available</span>
              <span>Warning</span>
              <Input
                type="number"
                aria-label="Warning available gigabytes"
                min={0}
                value={policy.warningBytes / 1e9}
                disabled={isSaving}
                onChange={(event) =>
                  set("warningBytes", Math.max(0, Math.round(Number(event.target.value) * 1e9)))
                }
              />
              <Input
                type="number"
                aria-label="Warning available percent"
                min={0}
                max={100}
                value={policy.warningPercent}
                disabled={isSaving}
                onChange={(event) =>
                  set("warningPercent", Math.max(0, Math.min(100, Number(event.target.value))))
                }
              />
              <span>Critical</span>
              <Input
                type="number"
                aria-label="Critical available gigabytes"
                min={0}
                value={policy.criticalBytes / 1e9}
                disabled={isSaving}
                onChange={(event) =>
                  set("criticalBytes", Math.max(0, Math.round(Number(event.target.value) * 1e9)))
                }
              />
              <Input
                type="number"
                aria-label="Critical available percent"
                min={0}
                max={100}
                value={policy.criticalPercent}
                disabled={isSaving}
                onChange={(event) =>
                  set("criticalPercent", Math.max(0, Math.min(100, Number(event.target.value))))
                }
              />
            </div>
            {invalidThresholds && (
              <p className="text-xs text-destructive">
                Warning limits must be higher than critical limits.
              </p>
            )}
          </fieldset>
          {selectedEntries.length > (entry ? 1 : 0) && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={applyToSelected}
                onCheckedChange={setApplyToSelected}
                disabled={isSaving}
              />
              Apply this policy to {selectedEntries.length} selected environments
            </label>
          )}
          <p className="text-xs text-muted-foreground">
            Snoozed, protected, shared busy worktrees and unique Git changes are skipped. Temporary
            threads retain their existing delete-on-settlement policy.
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={isSaving} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={isSaving || invalidThresholds} onClick={() => void save()}>
            {isSaving ? "Saving…" : entry ? "Save policy" : "Save defaults"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
