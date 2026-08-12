import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { ISSUES_IMPORT_CSV_MAX_CHARS, type IssuesImportCsvResult } from "@t3tools/contracts";
import { previewIssueCsv, type IssueCsvPreview } from "@t3tools/shared/issuesCsv";
import { FileUpIcon, XIcon } from "lucide-react";
import { useCallback, useRef, useState, type DragEvent } from "react";

import { cn } from "../../../lib/utils";
import { useImportIssuesCsv, useIssuesStoreStatus } from "../../../state/issues";
import { Button } from "../../ui/button";
import { ScrollArea } from "../../ui/scroll-area";
import { Spinner } from "../../ui/spinner";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settingsLayout";
import { searchableSetting } from "../settingsSearch";
import { issueCsvColumnLabel } from "./issuesSettings.logic";

interface SelectedFile {
  readonly name: string;
  readonly text: string;
  readonly preview: IssueCsvPreview;
}

/** Whole-file text: the RPC takes the file as one string, so streaming it would buy nothing. */
async function readSelectedFile(file: File): Promise<SelectedFile | { readonly error: string }> {
  if (file.size > ISSUES_IMPORT_CSV_MAX_CHARS) {
    return {
      error: "That file is larger than the import accepts. Split the export and try again.",
    };
  }
  const text = await file.text();
  if (text.length > ISSUES_IMPORT_CSV_MAX_CHARS) {
    return {
      error: "That file is larger than the import accepts. Split the export and try again.",
    };
  }
  return { name: file.name, text, preview: previewIssueCsv(text) };
}

export function ImportSettingsPanel() {
  const storeStatus = useIssuesStoreStatus();
  const importCsv = useImportIssuesCsv();
  const inputRef = useRef<HTMLInputElement>(null);

  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [result, setResult] = useState<IssuesImportCsvResult | null>(null);

  const acceptFile = useCallback((file: File | null | undefined) => {
    setResult(null);
    if (!file) return;
    void (async () => {
      const read = await readSelectedFile(file);
      if ("error" in read) {
        setSelected(null);
        setReadError(read.error);
        return;
      }
      setReadError(null);
      setSelected(read);
    })();
  }, []);

  const clearSelection = useCallback(() => {
    setSelected(null);
    setReadError(null);
    setResult(null);
    if (inputRef.current !== null) inputRef.current.value = "";
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDropTarget(false);
      acceptFile(event.dataTransfer.files.item(0));
    },
    [acceptFile],
  );

  const handleImport = useCallback(() => {
    if (selected === null) return;
    setIsImporting(true);
    void (async () => {
      try {
        const outcome: AtomCommandResult<IssuesImportCsvResult, unknown> = await importCsv({
          csvText: selected.text,
        });
        if (outcome._tag === "Failure") {
          if (isAtomCommandInterrupted(outcome)) return;
          const error = squashAtomCommandFailure(outcome);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Import failed",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
          return;
        }
        setResult(outcome.value);
        toastManager.add(
          stackedThreadToast({
            type: outcome.value.created === 0 ? "error" : "success",
            title:
              outcome.value.created === 1
                ? "Imported 1 issue"
                : `Imported ${outcome.value.created} issues`,
            description:
              outcome.value.skipped.length === 0
                ? `${selected.name} landed with nothing skipped.`
                : `${outcome.value.skipped.length} ${outcome.value.skipped.length === 1 ? "row was" : "rows were"} skipped.`,
          }),
        );
      } finally {
        setIsImporting(false);
      }
    })();
  }, [importCsv, selected]);

  const disconnected = storeStatus === "disconnected";
  const recognized = selected?.preview.columns.filter((column) => column.column !== null) ?? [];
  const ignored = selected?.preview.columns.filter((column) => column.column === null) ?? [];

  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("issue-import")}>
        <SettingsRow
          title="Import from CSV"
          description="Linear's CSV export drops in as-is: exported keys, statuses, priorities, labels, due dates, and parent links are all read. A status the tracker has never seen is created, and its workflow category is guessed from its name — check it on the Statuses page afterwards. Nothing is enriched on import."
        />

        <div className="px-3 sm:px-4">
          {/* A drop target, not a control: the Choose file button inside is the keyboard path. */}
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setIsDropTarget(true);
            }}
            onDragLeave={() => setIsDropTarget(false)}
            onDrop={handleDrop}
            className={cn(
              "flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-8 text-center transition-colors",
              isDropTarget ? "border-primary bg-accent/40" : "border-input",
              disconnected && "opacity-50",
            )}
          >
            <FileUpIcon className="size-5 text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">
                Drop a .csv here, or choose a file
              </p>
              <p className="text-[13px] text-muted-foreground/80">
                The file is read in this browser; only its text is sent to the environment.
              </p>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(event) => acceptFile(event.currentTarget.files?.item(0))}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={disconnected || isImporting}
              onClick={() => inputRef.current?.click()}
            >
              Choose file
            </Button>
          </div>
        </div>

        {readError !== null ? (
          <p className="px-3 pt-2 text-[13px] text-destructive-foreground sm:px-4">{readError}</p>
        ) : null}

        {selected !== null ? (
          <div className="mx-3 mt-3 space-y-3 rounded-xl border border-border p-3 sm:mx-4 sm:p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <p className="truncate text-sm font-medium text-foreground">{selected.name}</p>
                <p className="text-[13px] text-muted-foreground/80">
                  {selected.preview.rowCount === 1 ? "1 row" : `${selected.preview.rowCount} rows`}{" "}
                  · {selected.preview.columns.length} columns
                </p>
              </div>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Clear the selected file"
                disabled={isImporting}
                onClick={clearSelection}
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>

            {selected.preview.error !== null ? (
              <p className="text-[13px] text-destructive-foreground">{selected.preview.error}</p>
            ) : (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {recognized.map((column) => (
                    <span
                      key={column.header}
                      className="rounded-md bg-accent px-1.5 py-0.5 text-xs text-accent-foreground"
                      title={`Imported as ${issueCsvColumnLabel(column.column!)}`}
                    >
                      {column.header}
                    </span>
                  ))}
                </div>
                {ignored.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Ignored: {ignored.map((column) => column.header).join(", ")}
                  </p>
                ) : null}
              </div>
            )}

            <Button
              size="sm"
              disabled={isImporting || disconnected || selected.preview.error !== null}
              onClick={handleImport}
            >
              {isImporting ? <Spinner className="size-3.5" /> : null}
              {isImporting
                ? "Importing…"
                : selected.preview.rowCount === 1
                  ? "Import 1 row"
                  : `Import ${selected.preview.rowCount} rows`}
            </Button>
          </div>
        ) : null}

        {result !== null ? (
          <div className="mx-3 mt-3 space-y-3 rounded-xl border border-border p-3 sm:mx-4 sm:p-4">
            <p className="text-sm font-medium text-foreground">
              {result.created === 1 ? "1 issue created" : `${result.created} issues created`}
              {result.skipped.length === 0
                ? ""
                : `, ${result.skipped.length} ${result.skipped.length === 1 ? "row" : "rows"} skipped`}
            </p>
            {result.skipped.length > 0 ? (
              <ScrollArea scrollFade className="max-h-56">
                <ul className="space-y-1 pe-3 text-[13px]">
                  {result.skipped.map((skip) => (
                    <li key={skip.line} className="flex gap-2">
                      <span className="w-14 shrink-0 tabular-nums text-muted-foreground">
                        Line {skip.line}
                      </span>
                      <span className="min-w-0 text-muted-foreground/80">{skip.reason}</span>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            ) : null}
          </div>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
