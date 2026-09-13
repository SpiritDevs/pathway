import { useState } from "react";
import { randomUUID } from "../../lib/utils";
import { BookOpenIcon, CloudIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { DictationDictionaryList } from "@spiritdevs/contracts/dictation";
import { saveDictationDictionary } from "../../dictation/cloud";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SettingsSection } from "../settings/settingsLayout";
import { ConfirmDelete, Notice, type DictationActions } from "./DictationControls";
import { dictionaryValidation, normalizeDictionary } from "./dictationUi";

export function DictationDictionary({
  state,
  saveDictionary = saveDictationDictionary,
}: DictationActions & {
  saveDictionary?: typeof saveDictationDictionary;
}) {
  const [draft, setDraft] = useState<{
    lists: readonly DictationDictionaryList[];
    base: readonly DictationDictionaryList[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const lists = draft?.lists ?? state.dictionary;
  const canEdit = state.authenticated && state.dictionaryConnected && !saving;
  const validation = dictionaryValidation(lists);
  const change = (next: readonly DictationDictionaryList[]) => {
    setDraft({ lists: next, base: draft?.base ?? state.dictionary });
    setSaved(false);
    setError(null);
  };
  const changeList = (
    id: string,
    update: (list: DictationDictionaryList) => DictationDictionaryList,
  ) => change(lists.map((list) => (list.id === id ? update(list) : list)));
  const save = async () => {
    if (!canEdit || validation || !draft) return;
    setSaving(true);
    setError(null);
    try {
      await saveDictionary(normalizeDictionary(draft.lists), draft.base);
      setDraft(null);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsSection
      title="Dictionary"
      id="dictation-dictionary"
      icon={<BookOpenIcon className="size-4" />}
      headerAction={
        <Button
          size="sm"
          variant="outline"
          disabled={!canEdit}
          onClick={() => change([...lists, { id: randomUUID(), name: "New list", terms: [] }])}
        >
          <PlusIcon />
          New list
        </Button>
      }
    >
      <p className="px-4 pb-4 text-[13px] leading-relaxed text-muted-foreground">
        Teach Pathway the names and phrases you use. Every list applies to every dictation and syncs
        with your personal account.
      </p>
      <div className="mb-5 flex items-center gap-2 px-4 text-xs text-muted-foreground">
        <CloudIcon className="size-3.5" />
        {!state.dictionaryConnected
          ? "Offline · using your last synced dictionary"
          : draft
            ? "Unsaved changes"
            : saved
              ? "Changes saved"
              : "Connected to your Pathway account"}
      </div>
      {!state.dictionaryConnected && (
        <Notice>
          Connect to edit your dictionary. Your last synced terms still apply while you dictate
          offline.
        </Notice>
      )}
      {lists.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border px-6 py-12 text-center">
          <BookOpenIcon className="mx-auto mb-4 size-7 text-muted-foreground/60" />
          <h3 className="text-sm font-medium">Add your names and work terms</h3>
          <p className="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-muted-foreground">
            Add a list for people, projects, or work terms. Set the preferred spelling and any
            phrases that should be corrected to it.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-5"
            disabled={!canEdit}
            onClick={() =>
              change([
                {
                  id: randomUUID(),
                  name: "My dictionary",
                  terms: [{ id: randomUUID(), spelling: "", aliases: [] }],
                },
              ])
            }
          >
            <PlusIcon />
            Create your first list
          </Button>
        </div>
      )}
      <div className="space-y-4">
        {lists.map((list) => (
          <article key={list.id} className="overflow-hidden rounded-2xl border border-border/70">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-muted/20 p-4">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <BookOpenIcon className="size-4 shrink-0 text-muted-foreground" />
                <Input
                  aria-label="List name"
                  value={list.name}
                  disabled={!canEdit}
                  onChange={(event) =>
                    changeList(list.id, (current) => ({ ...current, name: event.target.value }))
                  }
                  className="max-w-72"
                />
                <span className="shrink-0 text-xs text-muted-foreground">
                  {list.terms.length} {list.terms.length === 1 ? "term" : "terms"}
                </span>
              </div>
              <ConfirmDelete
                label="Delete list"
                disabled={!canEdit}
                onConfirm={() => change(lists.filter((current) => current.id !== list.id))}
              />
            </div>
            <div className="divide-y divide-border/60 px-4">
              {list.terms.map((term) => (
                <div key={term.id} className="grid gap-4 py-4 sm:grid-cols-[1fr_1.4fr_auto]">
                  <label className="space-y-2 text-xs font-medium">
                    Preferred spelling
                    <Input
                      aria-label={`Preferred spelling in ${list.name}`}
                      placeholder="e.g. Pathway"
                      value={term.spelling}
                      disabled={!canEdit}
                      onChange={(event) =>
                        changeList(list.id, (current) => ({
                          ...current,
                          terms: current.terms.map((item) =>
                            item.id === term.id ? { ...item, spelling: event.target.value } : item,
                          ),
                        }))
                      }
                    />
                  </label>
                  <label className="space-y-2 text-xs font-medium">
                    Correct these phrases
                    <Textarea
                      aria-label={`Corrections for ${term.spelling || "new term"}`}
                      placeholder="One phrase per line, e.g. path way"
                      value={term.aliases.join("\n")}
                      disabled={!canEdit}
                      rows={2}
                      onChange={(event) =>
                        changeList(list.id, (current) => ({
                          ...current,
                          terms: current.terms.map((item) =>
                            item.id === term.id
                              ? { ...item, aliases: event.target.value.split("\n") }
                              : item,
                          ),
                        }))
                      }
                    />
                    <span className="block text-[11px] font-normal text-muted-foreground">
                      Optional. One phrase per line.
                    </span>
                  </label>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="sm:mt-6"
                    aria-label={`Delete ${term.spelling || "term"}`}
                    disabled={!canEdit}
                    onClick={() =>
                      changeList(list.id, (current) => ({
                        ...current,
                        terms: current.terms.filter((item) => item.id !== term.id),
                      }))
                    }
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            <div className="px-4 py-3">
              <Button
                size="sm"
                variant="ghost"
                disabled={!canEdit}
                onClick={() =>
                  changeList(list.id, (current) => ({
                    ...current,
                    terms: [...current.terms, { id: randomUUID(), spelling: "", aliases: [] }],
                  }))
                }
              >
                <PlusIcon />
                Add term
              </Button>
            </div>
          </article>
        ))}
      </div>
      {draft !== null && (
        <div className="sticky bottom-0 z-10 mt-5 space-y-3 rounded-xl border border-border bg-background p-4 shadow-sm">
          {(error || validation) && <Notice error>{error ?? validation}</Notice>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">Changes apply to your next recording.</p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() => {
                  setDraft(null);
                  setError(null);
                }}
              >
                Discard changes
              </Button>
              <Button
                size="sm"
                disabled={!canEdit || validation !== null}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Save dictionary"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
