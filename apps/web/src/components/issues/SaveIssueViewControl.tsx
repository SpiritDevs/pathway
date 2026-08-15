/**
 * The "Save view" affordance at the end of the `/issues` chip bar.
 *
 * It appears only once the params say something a bare `/issues` does not, and it names what is
 * about to be saved rather than making you guess: the trigger reads `Saved · <name>` when the
 * current params already *are* a saved view, and `Save view` otherwise.
 *
 * Typing the name of a view that exists turns the button into "Update view" and writes the config
 * back to that row. Two reasons: the server refuses a duplicate name outright, so a create was
 * never going to land there anyway, and re-saving under its own name is what a person wants after
 * moving one chip on a view they applied.
 *
 * @module components/issues/SaveIssueViewControl
 */
import { AsyncResult } from "effect/unstable/reactivity";
import type { MembershipId } from "@spiritdevs/contracts/company";
import { BookmarkCheckIcon, BookmarkPlusIcon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useCreateIssueView, useIssueViews, useUpdateIssueView } from "~/state/issues";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { reportIssueWriteFailure } from "./issueWriteFeedback";
import type { IssuesSearch } from "./issuesList.logic";
import {
  findIssueViewByName,
  findIssueViewForConfig,
  isIssueViewConfigDirty,
  issuesSearchViewConfig,
  summarizeIssueViewConfig,
} from "./issuesViews.logic";

export function SaveIssueViewControl({
  search,
  currentMembershipId = null,
  className,
}: {
  search: IssuesSearch;
  currentMembershipId?: MembershipId | null;
  className?: string;
}) {
  const views = useIssueViews();
  const createView = useCreateIssueView();
  const updateView = useUpdateIssueView();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const config = useMemo(
    () => issuesSearchViewConfig(search, currentMembershipId),
    [currentMembershipId, search],
  );
  const saved = findIssueViewForConfig(views, config, currentMembershipId);
  const summary = summarizeIssueViewConfig(config);

  // Opening prefills with the view these params already are, so the common path — apply a view,
  // move a chip, save it back — is one press and Enter. A stream update while the popover is up
  // must not retype the field, which is why the prefill is an event rather than a dependency.
  const prefillName = useEffectEvent(() => saved?.name ?? "");

  useEffect(() => {
    if (!open) return;
    setName(prefillName());
    setSubmitting(false);
    const frame = window.requestAnimationFrame(() => nameRef.current?.select());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const trimmed = name.trim();
  const existing = findIssueViewByName(views, trimmed);

  const submit = () => {
    if (trimmed.length === 0 || submitting) return;
    setSubmitting(true);
    void (async () => {
      const written = await (existing === null
        ? createView({ name: trimmed, config })
        : updateView({ viewId: existing.id, patch: { name: trimmed, config } }));
      setSubmitting(false);
      const failure = existing === null ? "Failed to save the view" : "Failed to update the view";
      if (reportIssueWriteFailure(failure, written)) return;
      if (!AsyncResult.isSuccess(written)) return;
      setOpen(false);
    })();
  };

  // Nothing to name yet: a view of everything is the list, and it already has a place to be.
  if (!isIssueViewConfigDirty(config)) return null;

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button className={cn("max-w-52", className)} size="xs" title={summary} variant="ghost">
            {saved === null ? <BookmarkPlusIcon /> : <BookmarkCheckIcon />}
            <span className="truncate">
              {saved === null ? "Save view" : `Saved · ${saved.name}`}
            </span>
          </Button>
        }
      />
      <PopoverPopup align="end" className="w-64 p-2" side="bottom">
        <p className="px-0.5 pb-1 text-xs text-muted-foreground">{summary}</p>
        <Input
          aria-label="View name"
          onChange={(event) => setName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            submit();
          }}
          placeholder="My bugs"
          ref={nameRef}
          size="sm"
          value={name}
        />
        {existing === null ? null : (
          <p className="px-0.5 pt-1.5 text-[11px] text-muted-foreground">
            {existing.name} already exists; saving points it at these filters.
          </p>
        )}
        <div className="mt-2 flex items-center justify-end gap-1.5">
          <Button
            disabled={submitting}
            onClick={() => setOpen(false)}
            size="xs"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
          <Button
            disabled={trimmed.length === 0 || submitting}
            onClick={submit}
            size="xs"
            type="button"
          >
            {existing === null ? "Save view" : "Update view"}
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
