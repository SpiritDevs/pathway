import type { AtomCommandResult } from "@spiritdevs/client-runtime/state/runtime";
import type { IssueLabel } from "@spiritdevs/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  useCreateIssueLabel,
  useDeleteIssueLabel,
  useCompanyIssuesStore,
  useUpdateIssueLabel,
} from "../../../state/issues";
import { ColorSelector } from "../../color-selector";
import { reportIssueWriteFailure as reportFailure } from "../../issues/issueWriteFeedback";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { Spinner } from "../../ui/spinner";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settingsLayout";
import { searchableSetting } from "../settingsSearch";
import { useCompanySettings } from "../company/useCompanySettings";
import {
  countIssuesByLabel,
  DEFAULT_ISSUE_COLOR,
  duplicateNameError,
  ISSUE_COLOR_OPTIONS,
} from "./issuesSettings.logic";

function LabelColorPicker({
  value,
  label,
  disabled = false,
  onSelect,
}: {
  value: string;
  label: string;
  disabled?: boolean;
  onSelect: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            disabled={disabled}
            aria-label={label}
            className="size-5 shrink-0 rounded-full border border-black/8 disabled:opacity-50 dark:border-white/12"
            style={{ backgroundColor: value }}
          />
        }
      />
      <PopoverPopup align="start" className="w-auto p-2">
        <ColorSelector
          key={value}
          colors={[...ISSUE_COLOR_OPTIONS]}
          defaultValue={value}
          size="lg"
          className="gap-1.5"
          onColorSelect={(color) => {
            setOpen(false);
            onSelect(color);
          }}
        />
      </PopoverPopup>
    </Popover>
  );
}

export function LabelsSettingsPanel() {
  const { companyId } = useCompanySettings();
  const { store, status: storeStatus } = useCompanyIssuesStore(companyId);
  const labels = store.labels;

  const createLabel = useCreateIssueLabel(companyId);
  const updateLabel = useUpdateIssueLabel(companyId);
  const deleteLabel = useDeleteIssueLabel(companyId);

  const [busy, setBusy] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftColor, setDraftColor] = useState(DEFAULT_ISSUE_COLOR);
  const [pendingDelete, setPendingDelete] = useState<IssueLabel | null>(null);

  const usage = useMemo(() => countIssuesByLabel(store), [store]);

  const run = useCallback(
    async (title: string, action: () => Promise<AtomCommandResult<unknown, unknown>>) => {
      setBusy(true);
      try {
        return !reportFailure(title, await action());
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const handleRename = useCallback(
    (label: IssueLabel, raw: string) => {
      const name = raw.trim();
      if (name === label.name) return;
      const error = duplicateNameError(labels, name, label.id);
      if (error !== null) {
        toastManager.add(
          stackedThreadToast({ type: "error", title: "Rename label", description: error }),
        );
        return;
      }
      void run("Failed to rename the label", () =>
        updateLabel({ labelId: label.id, patch: { name } }),
      );
    },
    [labels, run, updateLabel],
  );

  const handleAdd = useCallback(() => {
    const name = draftName.trim();
    const error = duplicateNameError(labels, name);
    if (error !== null) {
      toastManager.add(
        stackedThreadToast({ type: "error", title: "Add label", description: error }),
      );
      return;
    }
    void (async () => {
      const added = await run("Failed to add the label", () =>
        createLabel({ name, color: draftColor }),
      );
      if (added) {
        setDraftName("");
        setDraftColor(DEFAULT_ISSUE_COLOR);
      }
    })();
  }, [createLabel, draftColor, draftName, labels, run]);

  const handleDelete = useCallback(
    (label: IssueLabel) => {
      void (async () => {
        const deleted = await run("Failed to delete the label", () =>
          deleteLabel({ labelId: label.id }),
        );
        if (deleted) setPendingDelete(null);
      })();
    },
    [deleteLabel, run],
  );

  const pendingUsage = pendingDelete === null ? 0 : (usage.get(pendingDelete.id) ?? 0);

  if (storeStatus === "disconnected") {
    return (
      <SettingsPageContainer>
        <SettingsSection {...searchableSetting("issue-labels")}>
          <SettingsRow
            title="No environment connected"
            description="The issue tracker belongs to the environment you are connected to. Connect one to configure its labels."
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <>
      <SettingsPageContainer>
        <SettingsSection {...searchableSetting("issue-labels")}>
          <SettingsRow
            title="Labels"
            description="Flat and colour-coded, shared by every issue in this environment. Importing a CSV creates any label the file mentions."
          />
          {storeStatus === "loading" && labels.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground sm:px-4">
              <Spinner className="size-3.5" />
              Loading labels…
            </div>
          ) : labels.length === 0 ? (
            <p className="px-3 py-3 text-[13px] text-muted-foreground/80 sm:px-4">No labels yet.</p>
          ) : (
            labels.map((label) => {
              const count = usage.get(label.id) ?? 0;
              return (
                <div
                  key={label.id}
                  className="flex items-center gap-2 rounded-lg px-3 py-1.5 hover:bg-accent/30 sm:px-4"
                >
                  <LabelColorPicker
                    value={label.color}
                    label={`Change the colour of ${label.name}`}
                    disabled={busy}
                    onSelect={(color) =>
                      void run("Failed to recolour the label", () =>
                        updateLabel({ labelId: label.id, patch: { color } }),
                      )
                    }
                  />
                  <Input
                    key={label.name}
                    className="min-w-0 flex-1"
                    size="sm"
                    aria-label={`${label.name} name`}
                    defaultValue={label.name}
                    disabled={busy}
                    onBlur={(event) => handleRename(label, event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") {
                        event.currentTarget.value = label.name;
                        event.currentTarget.blur();
                      }
                    }}
                  />
                  <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {count === 1 ? "1 issue" : `${count} issues`}
                  </span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Delete ${label.name}`}
                    disabled={busy}
                    className="text-muted-foreground hover:text-destructive-foreground"
                    onClick={() => {
                      // A label nothing wears is trivially retyped, so only a used one is worth a
                      // dialog: deleting that one edits every issue wearing it.
                      if (count === 0) handleDelete(label);
                      else setPendingDelete(label);
                    }}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              );
            })
          )}

          <div className="flex items-center gap-2 px-3 py-1.5 sm:px-4">
            <LabelColorPicker
              value={draftColor}
              label="Colour for the new label"
              disabled={busy}
              onSelect={setDraftColor}
            />
            <Input
              className="min-w-0 flex-1"
              size="sm"
              aria-label="New label name"
              placeholder="Add a label…"
              value={draftName}
              disabled={busy}
              onChange={(event) => setDraftName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && draftName.trim() !== "") handleAdd();
              }}
            />
            <Button
              size="sm"
              variant="outline"
              className="w-16 shrink-0"
              disabled={busy || draftName.trim() === ""}
              onClick={handleAdd}
            >
              <PlusIcon className="size-3.5" />
              Add
            </Button>
            <span className="size-6 shrink-0" aria-hidden />
          </div>
        </SettingsSection>
      </SettingsPageContainer>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (busy) return;
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingUsage === 1
                ? "1 issue wears this label and will lose it. The issues themselves are untouched."
                : `${pendingUsage} issues wear this label and will lose it. The issues themselves are untouched.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={busy} render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (pendingDelete !== null) handleDelete(pendingDelete);
              }}
            >
              {busy ? <Spinner className="size-3.5" /> : null}
              Delete label
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
