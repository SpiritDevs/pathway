/**
 * Shared issue-label picker with inline creation. Both a draft issue and an existing issue can
 * choose labels here without detouring through Settings.
 *
 * @module components/issues/IssueLabelsPicker
 */
import type { IssueLabel, IssueLabelId } from "@spiritdevs/contracts";
import { CheckIcon, PlusIcon } from "lucide-react";
import { useState, type ReactElement } from "react";

import { ColorSelector } from "../color-selector";
import { DEFAULT_ISSUE_COLOR, ISSUE_COLOR_OPTIONS } from "../settings/issues/issuesSettings.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { IssueLabelDot } from "./IssueGlyphs";
import { issueLabelCreateName, nextIssueLabelColor } from "./issueDetail.logic";

export function IssueLabelsPicker({
  labels,
  selectedLabelIds,
  onToggle,
  onCreate,
  title,
  trigger,
}: {
  labels: ReadonlyArray<IssueLabel>;
  selectedLabelIds: ReadonlyArray<IssueLabelId>;
  onToggle: (labelId: IssueLabelId) => void;
  onCreate: (input: { readonly name: string; readonly color: string }) => Promise<boolean>;
  title?: string;
  trigger: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftColor, setDraftColor] = useState(DEFAULT_ISSUE_COLOR);
  const [creating, setCreating] = useState(false);

  const createName = issueLabelCreateName(draftName, labels);

  const submit = () => {
    if (createName === null || creating) return;
    setCreating(true);
    void (async () => {
      const created = await onCreate({ name: createName, color: draftColor });
      setCreating(false);
      if (!created) return;
      setDraftName("");
      setDraftColor(nextIssueLabelColor(ISSUE_COLOR_OPTIONS, labels, DEFAULT_ISSUE_COLOR));
    })();
  };

  return (
    <Popover
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setDraftColor(nextIssueLabelColor(ISSUE_COLOR_OPTIONS, labels, DEFAULT_ISSUE_COLOR));
        } else {
          setDraftName("");
        }
      }}
      open={open}
    >
      <PopoverTrigger render={trigger} />
      <PopoverPopup align="start" className="w-64 p-1.5">
        {title === undefined ? null : (
          <p className="px-1.5 py-1 text-xs font-medium text-muted-foreground">{title}</p>
        )}
        <div className="max-h-56 overflow-y-auto">
          {labels.length === 0 ? (
            <p className="px-1.5 py-1 text-xs text-muted-foreground">
              No labels yet. Type a name below to make the first one.
            </p>
          ) : (
            labels.map((label) => {
              const checked = selectedLabelIds.includes(label.id);
              return (
                <button
                  className="flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-start text-[13px] outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
                  key={label.id}
                  onClick={() => onToggle(label.id)}
                  type="button"
                >
                  <IssueLabelDot color={label.color} />
                  <span className="min-w-0 flex-1 truncate">{label.name}</span>
                  {checked ? <CheckIcon className="size-3.5 shrink-0 text-primary" /> : null}
                </button>
              );
            })
          )}
        </div>

        <div className="mt-1.5 border-t border-border/60 pt-1.5">
          <div className="flex items-center gap-1.5">
            <Popover>
              <PopoverTrigger
                render={
                  <button
                    aria-label="Colour for the new label"
                    className="size-5 shrink-0 rounded-full border border-black/8 dark:border-white/12"
                    disabled={creating}
                    style={{ backgroundColor: draftColor }}
                    type="button"
                  />
                }
              />
              <PopoverPopup align="start" className="w-auto p-2">
                <ColorSelector
                  className="gap-1.5"
                  colors={[...ISSUE_COLOR_OPTIONS]}
                  defaultValue={draftColor}
                  key={draftColor}
                  onColorSelect={setDraftColor}
                  size="lg"
                />
              </PopoverPopup>
            </Popover>
            <Input
              aria-label="New label name"
              className="min-w-0 flex-1"
              disabled={creating}
              onChange={(event) => setDraftName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                submit();
              }}
              placeholder="Create a label…"
              size="sm"
              value={draftName}
            />
            <Button
              aria-label="Create label"
              disabled={createName === null || creating}
              onClick={submit}
              size="icon-xs"
              variant="outline"
            >
              <PlusIcon />
            </Button>
          </div>
          {draftName.trim().length > 0 && createName === null ? (
            <p className="px-1 pt-1 text-[11px] text-muted-foreground">
              That label already exists.
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
