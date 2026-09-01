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
import type {
  CalendarEventAttachment,
  CalendarEventAttachmentId,
  CalendarEventId,
  CalendarEventInvitee,
} from "@spiritdevs/contracts";
import {
  BellIcon,
  ExternalLinkIcon,
  LinkIcon,
  LockIcon,
  MapPinIcon,
  PaperclipIcon,
  PlusIcon,
  Trash2Icon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { addIssueDays } from "../issues/issuesList.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Sheet,
  SheetClose,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "../ui/sheet";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
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
  readonly notes: string;
  readonly reminderMinutes: ReadonlyArray<number>;
  readonly urls: ReadonlyArray<string>;
  readonly location: string | null;
  readonly invitees: ReadonlyArray<CalendarEventInvitee>;
  readonly attachments: ReadonlyArray<CalendarEventAttachment>;
}

export type CalendarEventDraft =
  | ({ readonly mode: "create" } & CalendarEventDraftBase)
  | ({
      readonly mode: "edit";
      readonly eventId: CalendarEventId;
      /** False for a mirrored event: the form renders, the save button does not. */
      readonly editable: boolean;
    } & CalendarEventDraftBase);

export type CalendarEventSubmission = CalendarEventDraft & {
  readonly newAttachments: ReadonlyArray<File>;
  readonly removedAttachmentIds: ReadonlyArray<CalendarEventAttachmentId>;
};

const REMINDER_OPTIONS = [5, 10, 15, 30, 60, 120, 1_440] as const;

function reminderLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min before`;
  if (minutes === 60) return "1 hour before";
  if (minutes < 1_440) return `${minutes / 60} hours before`;
  return `${minutes / 1_440} day before`;
}

function validWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function CalendarEventDialog({
  draft,
  onClose,
  onDelete,
  onOpenAttachment,
  onSubmit,
}: {
  readonly draft: CalendarEventDraft;
  readonly onClose: () => void;
  /** Null for a create, and for a mirrored event that has nothing of ours to delete. */
  readonly onDelete: (() => void) | null;
  readonly onOpenAttachment: (
    eventId: CalendarEventId,
    attachmentId: CalendarEventAttachmentId,
  ) => Promise<void>;
  readonly onSubmit: (draft: CalendarEventSubmission) => Promise<void>;
}) {
  const editable = draft.mode === "create" || draft.editable;
  const initial = useMemo(() => toForm(draft), [draft]);
  const [title, setTitle] = useState(initial.title);
  const [allDay, setAllDay] = useState(initial.allDay);
  const [startDate, setStartDate] = useState(initial.startDate);
  const [startTime, setStartTime] = useState(initial.startTime);
  const [endDate, setEndDate] = useState(initial.endDate);
  const [endTime, setEndTime] = useState(initial.endTime);
  const [notes, setNotes] = useState(draft.notes);
  const [reminderMinutes, setReminderMinutes] = useState<ReadonlyArray<number>>(
    draft.reminderMinutes,
  );
  const [nextReminder, setNextReminder] = useState(15);
  const [urls, setUrls] = useState<ReadonlyArray<string>>(draft.urls);
  const [location, setLocation] = useState(draft.location ?? "");
  const [invitees, setInvitees] = useState<ReadonlyArray<CalendarEventInvitee>>(draft.invitees);
  const [newAttachments, setNewAttachments] = useState<ReadonlyArray<File>>([]);
  const [removedAttachmentIds, setRemovedAttachmentIds] = useState<
    ReadonlyArray<CalendarEventAttachmentId>
  >([]);
  const [submitting, setSubmitting] = useState(false);
  const attachmentInput = useRef<HTMLInputElement>(null);

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
  const urlsValid = urls.every((url) => url.trim().length === 0 || validWebUrl(url.trim()));
  const inviteesValid = invitees.every((invitee) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invitee.email.trim()),
  );
  const canSave =
    editable &&
    named &&
    resolved !== null &&
    !backwards &&
    urlsValid &&
    inviteesValid &&
    !submitting;

  const visibleAttachments = draft.attachments.filter(
    (attachment) => !removedAttachmentIds.includes(attachment.id),
  );

  return (
    <Sheet
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <SheetPopup className="sm:max-w-xl" side="right" variant="inset">
        <SheetHeader className="border-b border-border/60 px-5 py-4 pe-12">
          <SheetTitle>
            {draft.mode === "create" ? "New event" : editable ? "Event" : "Mirrored event"}
          </SheetTitle>
          <SheetDescription>
            {editable ? (
              <>Times are in {draft.timeZone}, the zone this event is kept in.</>
            ) : (
              <span className="flex items-center gap-1.5">
                <LockIcon className="size-3 shrink-0" />
                Copied from Google. Change it there and the change arrives here.
              </span>
            )}
          </SheetDescription>
        </SheetHeader>

        <SheetPanel className="flex flex-col gap-5 px-5 py-4">
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

          <section className="flex flex-col gap-2" aria-labelledby="event-reminders-label">
            <div className="flex items-center gap-2 text-xs font-medium" id="event-reminders-label">
              <BellIcon className="size-3.5 text-muted-foreground" />
              Alerts
            </div>
            <p className="text-[11px] text-muted-foreground">
              A sound and notification always fire when the event starts.
            </p>
            {editable ? (
              <div className="flex gap-2">
                <select
                  aria-label="Reminder lead time"
                  className={FIELD_CLASS}
                  onChange={(event) => setNextReminder(Number(event.currentTarget.value))}
                  value={nextReminder}
                >
                  {REMINDER_OPTIONS.map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {reminderLabel(minutes)}
                    </option>
                  ))}
                </select>
                <Button
                  onClick={() =>
                    setReminderMinutes((current) =>
                      current.includes(nextReminder)
                        ? current
                        : [...current, nextReminder].sort((a, b) => a - b),
                    )
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <PlusIcon /> Add
                </Button>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-1.5">
              {reminderMinutes.map((minutes) => (
                <span
                  className="flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-[11px]"
                  key={minutes}
                >
                  {reminderLabel(minutes)}
                  {editable ? (
                    <button
                      aria-label={`Remove ${reminderLabel(minutes)}`}
                      onClick={() =>
                        setReminderMinutes((current) => current.filter((item) => item !== minutes))
                      }
                      type="button"
                    >
                      <XIcon className="size-3" />
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          </section>

          <Label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            Notes
            <Textarea
              disabled={!editable}
              onChange={(event) => setNotes(event.currentTarget.value)}
              placeholder="Add context, an agenda, or preparation notes"
              rows={5}
              value={notes}
            />
          </Label>

          <LocationField disabled={!editable} onChange={setLocation} value={location} />

          <EditableList
            addLabel="Add link"
            disabled={!editable}
            icon={<LinkIcon className="size-3.5" />}
            invalid={(value) => value.trim().length > 0 && !validWebUrl(value.trim())}
            label="Web links"
            onChange={setUrls}
            placeholder="https://meet.example.com/..."
            values={urls}
          />

          <EditableList
            addLabel="Add invitee"
            disabled={!editable}
            icon={<UserRoundIcon className="size-3.5" />}
            invalid={(value) =>
              value.trim().length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
            }
            label="Invitees"
            onChange={(values) =>
              setInvitees(
                values.map((email, index) => ({
                  email,
                  name: invitees[index]?.name ?? null,
                  response: invitees[index]?.response ?? "needs-action",
                })),
              )
            }
            placeholder="person@example.com"
            values={invitees.map((invitee) => invitee.email)}
          />

          <section className="flex flex-col gap-2" aria-labelledby="event-attachments-label">
            <div
              className="flex items-center gap-2 text-xs font-medium"
              id="event-attachments-label"
            >
              <PaperclipIcon className="size-3.5 text-muted-foreground" />
              Attachments
              {editable ? (
                <Button
                  className="ms-auto"
                  onClick={() => attachmentInput.current?.click()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <PlusIcon /> Add files
                </Button>
              ) : null}
              <input
                className="hidden"
                multiple
                onChange={(event) => {
                  const files = [...(event.currentTarget.files ?? [])];
                  const accepted = files.filter((file) => file.size <= 25 * 1024 * 1024);
                  if (accepted.length !== files.length) {
                    toastManager.add({
                      type: "error",
                      title: "Attachments must be 25 MB or smaller",
                    });
                  }
                  setNewAttachments((current) =>
                    [
                      ...current,
                      ...accepted.filter(
                        (file) =>
                          !current.some(
                            (item) =>
                              item.name === file.name &&
                              item.size === file.size &&
                              item.lastModified === file.lastModified,
                          ),
                      ),
                    ].slice(0, 8 - visibleAttachments.length),
                  );
                  event.currentTarget.value = "";
                }}
                ref={attachmentInput}
                type="file"
              />
            </div>
            {visibleAttachments.length === 0 && newAttachments.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No files attached.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {visibleAttachments.map((attachment) => (
                  <li
                    className="flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 text-xs"
                    key={attachment.id}
                  >
                    <PaperclipIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <button
                      className="min-w-0 truncate text-start hover:underline disabled:no-underline"
                      disabled={draft.mode !== "edit"}
                      onClick={() => {
                        if (draft.mode !== "edit") return;
                        void onOpenAttachment(draft.eventId, attachment.id).catch(
                          (error: unknown) =>
                            toastManager.add(
                              stackedThreadToast({
                                type: "error",
                                title: "Attachment unavailable",
                                description:
                                  error instanceof Error
                                    ? error.message
                                    : "The file could not be opened.",
                              }),
                            ),
                        );
                      }}
                      type="button"
                    >
                      {attachment.fileName}
                    </button>
                    <span className="ms-auto shrink-0 text-[10px] text-muted-foreground">
                      {formatBytes(attachment.byteSize)}
                    </span>
                    {editable ? (
                      <button
                        aria-label={`Remove ${attachment.fileName}`}
                        onClick={() =>
                          setRemovedAttachmentIds((current) => [...current, attachment.id])
                        }
                        type="button"
                      >
                        <XIcon className="size-3.5" />
                      </button>
                    ) : null}
                  </li>
                ))}
                {newAttachments.map((file) => (
                  <li
                    className="flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 text-xs"
                    key={`${file.name}:${file.size}:${file.lastModified}`}
                  >
                    <PaperclipIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">{file.name}</span>
                    <span className="ms-auto shrink-0 text-[10px] text-muted-foreground">
                      {formatBytes(file.size)}
                    </span>
                    <button
                      aria-label={`Remove ${file.name}`}
                      onClick={() =>
                        setNewAttachments((current) => current.filter((item) => item !== file))
                      }
                      type="button"
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </SheetPanel>

        <SheetFooter className="px-5">
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
          <SheetClose render={<Button disabled={submitting} size="sm" variant="ghost" />}>
            {editable ? "Cancel" : "Close"}
          </SheetClose>
          {editable ? (
            <Button
              disabled={!canSave}
              onClick={() => {
                if (resolved === null || !canSave) return;
                setSubmitting(true);
                void onSubmit({
                  ...draft,
                  title: title.trim(),
                  allDay,
                  notes,
                  reminderMinutes,
                  urls: urls.map((url) => url.trim()).filter(Boolean),
                  location: location.trim() || null,
                  invitees: invitees
                    .map((invitee) => ({ ...invitee, email: invitee.email.trim() }))
                    .filter((invitee) => invitee.email.length > 0),
                  newAttachments,
                  removedAttachmentIds,
                  ...resolved,
                }).finally(() => setSubmitting(false));
              }}
              size="sm"
            >
              {submitting ? "Saving…" : draft.mode === "create" ? "Create" : "Save"}
            </Button>
          ) : null}
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
}

function EditableList({
  addLabel,
  disabled,
  icon,
  invalid,
  label,
  onChange,
  placeholder,
  values,
}: {
  readonly addLabel: string;
  readonly disabled: boolean;
  readonly icon: React.ReactNode;
  readonly invalid: (value: string) => boolean;
  readonly label: string;
  readonly onChange: (values: ReadonlyArray<string>) => void;
  readonly placeholder: string;
  readonly values: ReadonlyArray<string>;
}) {
  const rowKeys = useRef<ReadonlyArray<string>>([]);
  if (rowKeys.current.length < values.length) {
    rowKeys.current = [
      ...rowKeys.current,
      ...Array.from({ length: values.length - rowKeys.current.length }, randomUUID),
    ];
  } else if (rowKeys.current.length > values.length) {
    rowKeys.current = rowKeys.current.slice(0, values.length);
  }
  const rows = values.map((value, index) => ({ key: rowKeys.current[index]!, value }));

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs font-medium text-foreground">
        <span className="text-muted-foreground">{icon}</span>
        {label}
        {disabled ? null : (
          <Button
            className="ms-auto"
            onClick={() => {
              rowKeys.current = [...rowKeys.current, randomUUID()];
              onChange([...values, ""]);
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            <PlusIcon /> {addLabel}
          </Button>
        )}
      </div>
      {values.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">None added.</p>
      ) : (
        rows.map((row) => (
          <div className="flex items-center gap-2" key={row.key}>
            <Input
              aria-invalid={invalid(row.value)}
              disabled={disabled}
              onChange={(event) => {
                const index = rowKeys.current.indexOf(row.key);
                onChange(
                  values.map((item, itemIndex) =>
                    itemIndex === index ? event.currentTarget.value : item,
                  ),
                );
              }}
              placeholder={placeholder}
              type={label === "Invitees" ? "email" : "url"}
              value={row.value}
            />
            {label === "Web links" && validWebUrl(row.value) ? (
              <a aria-label="Open link" href={row.value} rel="noreferrer" target="_blank">
                <ExternalLinkIcon className="size-4 text-muted-foreground" />
              </a>
            ) : null}
            {disabled ? null : (
              <Button
                aria-label={`Remove ${label.toLowerCase()} row`}
                onClick={() => {
                  const index = rowKeys.current.indexOf(row.key);
                  rowKeys.current = rowKeys.current.filter((key) => key !== row.key);
                  onChange(values.filter((_, itemIndex) => itemIndex !== index));
                }}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <XIcon />
              </Button>
            )}
          </div>
        ))
      )}
    </section>
  );
}

interface LocationSuggestion {
  readonly display_name: string;
}

function LocationField({
  disabled,
  onChange,
  value,
}: {
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) {
  const [suggestions, setSuggestions] = useState<ReadonlyArray<LocationSuggestion>>([]);
  useEffect(() => {
    if (disabled || value.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({
        q: value,
        format: "jsonv2",
        addressdetails: "1",
        limit: "5",
      });
      void fetch(`https://nominatim.openstreetmap.org/search?${query}`, {
        headers: { "Accept-Language": navigator.language },
        signal: controller.signal,
      })
        .then((response) => (response.ok ? response.json() : []))
        .then((result: unknown) => {
          if (Array.isArray(result))
            setSuggestions(
              result.filter(
                (item): item is LocationSuggestion =>
                  typeof item === "object" &&
                  item !== null &&
                  typeof (item as Record<string, unknown>)["display_name"] === "string",
              ),
            );
        })
        .catch(() => undefined);
    }, 600);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [disabled, value]);
  return (
    <section className="relative flex flex-col gap-1.5">
      <Label className="flex items-center gap-2 text-xs">
        <MapPinIcon className="size-3.5 text-muted-foreground" />
        Location or online room
      </Label>
      <Input
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder="Search an address or enter an online room"
        value={value}
      />
      {suggestions.length === 0 ? null : (
        <ul className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-md border bg-popover shadow-md">
          {suggestions.map((suggestion) => (
            <li key={suggestion.display_name}>
              <button
                className="w-full px-3 py-2 text-start text-xs hover:bg-accent"
                onClick={() => {
                  onChange(suggestion.display_name);
                  setSuggestions([]);
                }}
                type="button"
              >
                {suggestion.display_name}
              </button>
            </li>
          ))}
          <li className="border-t px-3 py-1 text-[9px] text-muted-foreground">
            Search by OpenStreetMap
          </li>
        </ul>
      )}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
