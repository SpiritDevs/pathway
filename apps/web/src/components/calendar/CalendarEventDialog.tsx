/**
 * The non-drag path into an event, and the only path from a keyboard: name it, set its ends, make
 * it all-day, or delete it.
 *
 * A dialog rather than a popover anchored to the block, because the block it would hang off moves
 * — a drag can end anywhere, and `c` opens this with no block on screen at all. Times are typed as
 * a date and a wall clock in the event's own zone and converted back through
 * {@link calendarInstantAt}, so what is typed is what the grid then draws.
 *
 * A mirrored Google event opens here read-only. There is nothing to save and no delete: the mirror
 * is a copy, and editing it in Pathway would either be lost on the next sync or would need a write
 * back to Google that the mirror deliberately does not do.
 *
 * @module components/calendar/CalendarEventDialog
 */
import type { CalendarEventId } from "@spiritdevs/contracts";
import { LockIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import { addIssueDays } from "../issues/issuesList.logic";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import {
  CALENDAR_SNAP_MINUTES,
  MINUTES_PER_DAY,
  calendarDayBounds,
  calendarInstantAt,
  calendarWallClock,
} from "./calendarGrid.logic";

/** Native entry, the same controls the milestone dates popover uses. */
const FIELD_CLASS =
  "h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm tabular-nums outline-none [color-scheme:light] focus-visible:ring-2 focus-visible:ring-ring dark:[color-scheme:dark]";

interface CalendarEventDraftBase {
  readonly title: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly timeZone: string;
  readonly allDay: boolean;
}

export type CalendarEventDraft =
  | ({ readonly mode: "create" } & CalendarEventDraftBase)
  | ({
      readonly mode: "edit";
      readonly eventId: CalendarEventId;
      /** False for a mirrored event: the form renders, the save button does not. */
      readonly editable: boolean;
    } & CalendarEventDraftBase);

export function CalendarEventDialog({
  draft,
  onClose,
  onDelete,
  onSubmit,
}: {
  readonly draft: CalendarEventDraft;
  readonly onClose: () => void;
  /** Null for a create, and for a mirrored event that has nothing of ours to delete. */
  readonly onDelete: (() => void) | null;
  readonly onSubmit: (draft: CalendarEventDraft) => void;
}) {
  const editable = draft.mode === "create" || draft.editable;
  const initial = useMemo(() => toForm(draft), [draft]);
  const [title, setTitle] = useState(initial.title);
  const [allDay, setAllDay] = useState(initial.allDay);
  const [startDate, setStartDate] = useState(initial.startDate);
  const [startTime, setStartTime] = useState(initial.startTime);
  const [endDate, setEndDate] = useState(initial.endDate);
  const [endTime, setEndTime] = useState(initial.endTime);

  const resolved = useMemo(
    () =>
      fromForm({
        allDay,
        endDate,
        endTime,
        startDate,
        startTime,
        timeZone: draft.timeZone,
      }),
    [allDay, draft.timeZone, endDate, endTime, startDate, startTime],
  );
  const backwards = resolved !== null && resolved.endAt <= resolved.startAt;
  const named = title.trim().length > 0;
  const canSave = editable && named && resolved !== null && !backwards;

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogPopup className="sm:max-w-md">
        <DialogPanel>
          <DialogHeader>
            <DialogTitle>
              {draft.mode === "create" ? "New event" : editable ? "Event" : "Mirrored event"}
            </DialogTitle>
            <DialogDescription>
              {editable ? (
                <>Times are in {draft.timeZone}, the zone this event is kept in.</>
              ) : (
                <span className="flex items-center gap-1.5">
                  <LockIcon className="size-3 shrink-0" />
                  Copied from Google. Change it there and the change arrives here.
                </span>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <Label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              Title
              <Input
                autoFocus={editable}
                disabled={!editable}
                onChange={(event) => setTitle(event.currentTarget.value)}
                placeholder="What is it?"
                value={title}
              />
            </Label>

            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground" htmlFor="calendar-all-day">
                All day
              </Label>
              <Switch
                checked={allDay}
                disabled={!editable}
                id="calendar-all-day"
                onCheckedChange={setAllDay}
              />
            </div>

            <div className="flex items-end gap-2">
              <Label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] text-muted-foreground">
                Starts
                <input
                  aria-label="Start date"
                  className={FIELD_CLASS}
                  disabled={!editable}
                  onChange={(event) => setStartDate(event.currentTarget.value)}
                  type="date"
                  value={startDate}
                />
              </Label>
              {allDay ? null : (
                <input
                  aria-label="Start time"
                  className={`${FIELD_CLASS} max-w-28`}
                  disabled={!editable}
                  onChange={(event) => setStartTime(event.currentTarget.value)}
                  type="time"
                  value={startTime}
                />
              )}
            </div>

            <div className="flex items-end gap-2">
              <Label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] text-muted-foreground">
                Ends
                <input
                  aria-label="End date"
                  className={FIELD_CLASS}
                  disabled={!editable}
                  onChange={(event) => setEndDate(event.currentTarget.value)}
                  type="date"
                  value={endDate}
                />
              </Label>
              {allDay ? null : (
                <input
                  aria-label="End time"
                  className={`${FIELD_CLASS} max-w-28`}
                  disabled={!editable}
                  onChange={(event) => setEndTime(event.currentTarget.value)}
                  type="time"
                  value={endTime}
                />
              )}
            </div>

            {backwards ? (
              <p className="text-[11px] text-destructive-foreground">
                An event cannot end before it starts.
              </p>
            ) : null}
          </div>

          <DialogFooter>
            {onDelete === null ? null : (
              <Button
                className="me-auto text-muted-foreground"
                onClick={onDelete}
                size="sm"
                variant="ghost"
              >
                <Trash2Icon />
                Delete
              </Button>
            )}
            <DialogClose render={<Button size="sm" variant="ghost" />}>
              {editable ? "Cancel" : "Close"}
            </DialogClose>
            {editable ? (
              <Button
                disabled={!canSave}
                onClick={() => {
                  if (resolved === null || !canSave) return;
                  onSubmit(
                    draft.mode === "create"
                      ? { ...draft, title: title.trim(), allDay, ...resolved }
                      : { ...draft, title: title.trim(), allDay, ...resolved },
                  );
                }}
                size="sm"
              >
                {draft.mode === "create" ? "Create" : "Save"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

interface EventForm {
  readonly title: string;
  readonly allDay: boolean;
  readonly startDate: string;
  readonly startTime: string;
  readonly endDate: string;
  readonly endTime: string;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function clockOf(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/**
 * The stored instants as fields.
 *
 * An all-day event stores midnight opening the day after its last, so the field shows the day
 * before that: what somebody typed as "the 12th to the 13th" has to come back as the 12th to the
 * 13th rather than as the 12th to the 14th.
 */
function toForm(draft: CalendarEventDraft): EventForm {
  const start = calendarWallClock(draft.startAt, draft.timeZone);
  const rawEnd = calendarWallClock(
    draft.allDay ? Math.max(draft.startAt, draft.endAt - 60_000) : draft.endAt,
    draft.timeZone,
  );
  return {
    title: draft.title,
    allDay: draft.allDay,
    startDate: start.date,
    startTime: clockOf(start.minutes),
    endDate: rawEnd.date,
    endTime: clockOf(rawEnd.minutes),
  };
}

function minutesOf(clock: string): number | null {
  const [hour, minute] = clock.split(":").map(Number);
  if (hour === undefined || minute === undefined) return null;
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const total = hour * 60 + minute;
  return total < 0 || total >= MINUTES_PER_DAY ? null : total;
}

/** The fields back as instants, or null while something is half-typed. */
function fromForm(input: {
  readonly allDay: boolean;
  readonly startDate: string;
  readonly startTime: string;
  readonly endDate: string;
  readonly endTime: string;
  readonly timeZone: string;
}): { readonly startAt: number; readonly endAt: number } | null {
  if (input.startDate.length === 0 || input.endDate.length === 0) return null;
  if (input.allDay) {
    return calendarDayBounds({
      startDate: input.startDate,
      // An all-day event that ends before it starts is one day long, not a negative span.
      endDate: input.endDate < input.startDate ? input.startDate : input.endDate,
      timeZone: input.timeZone,
    });
  }
  const startMinutes = minutesOf(input.startTime);
  const endMinutes = minutesOf(input.endTime);
  if (startMinutes === null || endMinutes === null) return null;
  return {
    startAt: calendarInstantAt(input.startDate, startMinutes, input.timeZone),
    endAt: calendarInstantAt(input.endDate, endMinutes, input.timeZone),
  };
}

/** Exported for the tests that pin the round trip; the dialog itself keeps them private. */
export const calendarEventFormInternals = {
  fromForm,
  toForm,
  /** The shortest event the form will accept, matching the grid's own resize floor. */
  minimumMinutes: CALENDAR_SNAP_MINUTES,
  /** One day later, used when an all-day span is normalised. */
  nextDay: (date: string) => addIssueDays(date, 1),
};
