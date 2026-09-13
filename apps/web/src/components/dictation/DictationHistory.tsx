import { useEffect, useMemo, useState } from "react";
import { CheckIcon, CopyIcon, HistoryIcon, SearchIcon, Trash2Icon } from "lucide-react";
import type { DictationBridge, DictationHistoryEntry } from "@spiritdevs/contracts/dictation";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "../settings/settingsLayout";
import { ConfirmDelete, Notice, type DictationActions } from "./DictationControls";
import { formatDuration } from "./dictationUi";

export function DictationHistory({
  state,
  execute,
  bridge,
}: DictationActions & { bridge: DictationBridge }) {
  const [entries, setEntries] = useState<readonly DictationHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(50);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    // Hide old account data immediately while its replacement loads.
    setEntries([]);
    setLoading(true);
    void bridge
      .listHistory()
      .then((history) => {
        if (active) {
          setEntries(history);
          setError(null);
          setLoading(false);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [bridge, revision, state.authenticated, state.result?.id, state.preferences.retentionDays]);

  const copy = async (entry: DictationHistoryEntry, original = false) => {
    const result = await execute({
      type: "copy",
      text: original ? entry.originalText : entry.text,
    });
    if (result) setCopied(`${entry.id}:${original ? "original" : "cleaned"}`);
  };
  const remove = async (id: string | null) => {
    if (await execute({ type: "delete-history", id })) setRevision((value) => value + 1);
  };
  const visible = useMemo(
    () =>
      entries.filter((entry) =>
        `${entry.text}\n${entry.originalText}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
      ),
    [entries, query],
  );
  return (
    <SettingsSection
      title="History"
      id="dictation-history"
      icon={<HistoryIcon className="size-4" />}
      headerAction={
        <ConfirmDelete
          label="Delete all history"
          disabled={entries.length === 0}
          onConfirm={() => void remove(null)}
        />
      }
    >
      <p className="px-4 pb-4 text-[13px] leading-relaxed text-muted-foreground">
        Your words, saved on this desktop. History includes original and cleaned text. No audio is
        kept.
      </p>
      {!state.preferences.saveHistory && (
        <Notice>
          Saving is off. New dictations will not appear here. Existing entries still follow your
          retention setting.
        </Notice>
      )}
      <div className="relative my-4">
        <SearchIcon className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
        <Input
          aria-label="Search dictation history"
          placeholder="Search your dictations…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(50);
          }}
          className="pl-9"
        />
      </div>
      {error && (
        <Notice error>
          {error}{" "}
          <Button size="sm" variant="ghost" onClick={() => setRevision((value) => value + 1)}>
            Try again
          </Button>
        </Notice>
      )}
      {loading ? (
        <p role="status" className="px-4 py-10 text-center text-sm text-muted-foreground">
          Loading history…
        </p>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border px-6 py-14 text-center">
          <HistoryIcon className="mx-auto mb-4 size-7 text-muted-foreground/60" />
          <h3 className="text-sm font-medium">
            {query ? "No matching dictations" : "Your next dictation starts here"}
          </h3>
          <p className="mt-2 text-[13px] text-muted-foreground">
            {query
              ? "Try another word or phrase."
              : "Record with your shortcut or the dictation bar. Saved text will appear here."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.slice(0, limit).map((entry) => (
            <article key={entry.id} className="rounded-2xl border border-border/70 p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <time dateTime={entry.createdAt}>
                    {new Date(entry.createdAt).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </time>
                  <span>·</span>
                  <span>{formatDuration(entry.durationMs)}</span>
                  {entry.delivery === "test" && <span>· Microphone test</span>}
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => void copy(entry)}>
                    {copied === `${entry.id}:cleaned` ? <CheckIcon /> : <CopyIcon />}
                    {copied === `${entry.id}:cleaned` ? "Copied" : "Copy"}
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Delete dictation"
                    onClick={() => void remove(entry.id)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              </div>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {entry.text}
              </p>
              {entry.cleanup === "unavailable" && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Cleanup was unavailable. Recognized text was kept.
                </p>
              )}
              <details className="mt-4 border-t border-border/60 pt-3">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  Original transcript
                </summary>
                <div className="mt-3 rounded-lg bg-muted/30 p-3">
                  <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-muted-foreground">
                    {entry.originalText}
                  </p>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="mt-2"
                    onClick={() => void copy(entry, true)}
                  >
                    {copied === `${entry.id}:original` ? <CheckIcon /> : <CopyIcon />}
                    {copied === `${entry.id}:original` ? "Copied original" : "Copy original"}
                  </Button>
                </div>
              </details>
            </article>
          ))}
        </div>
      )}
      {visible.length > limit && (
        <div className="flex justify-center pt-4">
          <Button size="sm" variant="outline" onClick={() => setLimit((value) => value + 50)}>
            Show more dictations
          </Button>
        </div>
      )}
    </SettingsSection>
  );
}
