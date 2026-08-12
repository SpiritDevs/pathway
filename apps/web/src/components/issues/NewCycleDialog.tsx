/**
 * The whole cycle-management surface in stage 2: name, start, end.
 *
 * A cycle is a hand-created date range, not a generated cadence — there is no scheduler on this
 * server — so there is nothing else to configure, and a full management page would be three fields
 * with a table around them.
 *
 * @module components/issues/NewCycleDialog
 */
import type { IssueDate } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useRef, useState } from "react";

import { useCreateIssueCycle } from "~/state/issues";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { reportIssueWriteFailure } from "./issueWriteFeedback";
import { issueCycleDraftError } from "./issueDetail.logic";

const DATE_INPUT_CLASS =
  "h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm tabular-nums outline-none [color-scheme:light] focus-visible:ring-2 focus-visible:ring-ring dark:[color-scheme:dark]";

export function NewCycleDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createCycle = useCreateIssueCycle();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setStartDate("");
    setEndDate("");
    setSubmitting(false);
    const frame = window.requestAnimationFrame(() => nameRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const error = issueCycleDraftError({ name, startDate, endDate });

  const submit = () => {
    if (error !== null || submitting) return;
    setSubmitting(true);
    void (async () => {
      const created = await createCycle({
        name: name.trim(),
        startDate: startDate.trim() as IssueDate,
        endDate: endDate.trim() as IssueDate,
      });
      setSubmitting(false);
      if (reportIssueWriteFailure("Failed to create the cycle", created)) return;
      if (!AsyncResult.isSuccess(created)) return;
      onOpenChange(false);
    })();
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
      open={open}
    >
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>New cycle</DialogTitle>
          <DialogDescription>
            Cycles span every project. Unfinished issues move to the next one when this one ends.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <Input
            aria-label="Cycle name"
            onChange={(event) => setName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              submit();
            }}
            placeholder="Cycle 4"
            ref={nameRef}
            value={name}
          />
          <div className="flex items-center gap-2">
            <Label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
              Starts
              <input
                aria-label="Cycle start date"
                className={DATE_INPUT_CLASS}
                onChange={(event) => setStartDate(event.currentTarget.value)}
                type="date"
                value={startDate}
              />
            </Label>
            <Label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
              Ends
              <input
                aria-label="Cycle end date"
                className={DATE_INPUT_CLASS}
                onChange={(event) => setEndDate(event.currentTarget.value)}
                type="date"
                value={endDate}
              />
            </Label>
          </div>
          {/* Only after something has been typed: an untouched form is not yet wrong. */}
          {error === null || name.trim().length === 0 ? null : (
            <p className="text-xs text-destructive-foreground">{error}</p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button
            disabled={submitting}
            onClick={() => onOpenChange(false)}
            size="sm"
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button disabled={error !== null || submitting} onClick={submit} size="sm" type="button">
            Create cycle
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
