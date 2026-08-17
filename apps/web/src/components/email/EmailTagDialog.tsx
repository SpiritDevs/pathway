import type { EmailTag, EmailTagId } from "@spiritdevs/contracts";
import { CheckIcon, MinusIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ColorSelector } from "../color-selector";
import { DEFAULT_ISSUE_COLOR, ISSUE_COLOR_OPTIONS } from "../settings/issues/issuesSettings.logic";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";

export interface EmailTagTarget {
  readonly tagIds: ReadonlyArray<EmailTagId>;
}

export function EmailTagDialog({
  open,
  tags,
  targets,
  busy,
  onOpenChange,
  onSetTag,
  onCreate,
}: {
  open: boolean;
  tags: ReadonlyArray<EmailTag>;
  targets: ReadonlyArray<EmailTagTarget>;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSetTag: (tagId: EmailTagId, present: boolean) => void;
  onCreate: (input: { name: string; color: string }) => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_ISSUE_COLOR);
  useEffect(() => {
    if (!open) setName("");
  }, [open]);
  const trimmed = name.trim();
  const duplicate = tags.some(
    (tag) => tag.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
  );

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Tags</DialogTitle>
          <DialogDescription>
            {targets.length === 1
              ? "Add or remove tags on this message."
              : `Add or remove tags on ${targets.length} messages.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {tags.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">No tags yet.</p>
            ) : (
              tags.map((tag) => {
                const count = targets.filter((target) => target.tagIds.includes(tag.id)).length;
                const all = count === targets.length;
                return (
                  <button
                    className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-start text-sm hover:bg-accent/60 disabled:opacity-50"
                    disabled={busy}
                    key={tag.id}
                    onClick={() => onSetTag(tag.id, !all)}
                    type="button"
                  >
                    <span
                      className="size-2.5 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                    {all ? (
                      <CheckIcon className="size-4 text-primary" />
                    ) : count > 0 ? (
                      <MinusIcon className="size-4 text-muted-foreground" />
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
          <div className="space-y-2 border-t border-border/60 pt-3">
            <p className="text-xs font-medium text-muted-foreground">Create a tag</p>
            <ColorSelector
              colors={[...ISSUE_COLOR_OPTIONS]}
              defaultValue={color}
              key={color}
              onColorSelect={setColor}
              size="sm"
            />
            <div className="flex gap-2">
              <Input
                aria-label="New email tag name"
                disabled={busy}
                onChange={(event) => setName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || trimmed.length === 0 || duplicate) return;
                  event.preventDefault();
                  onCreate({ name: trimmed, color });
                }}
                placeholder="Tag name"
                size="sm"
                value={name}
              />
              <Button
                disabled={busy || trimmed.length === 0 || duplicate}
                onClick={() => onCreate({ name: trimmed, color })}
                size="sm"
                variant="outline"
              >
                {busy ? <Spinner className="size-3.5" /> : <PlusIcon className="size-3.5" />}
                Add
              </Button>
            </div>
            {duplicate ? (
              <p className="text-xs text-muted-foreground">That tag already exists.</p>
            ) : null}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
