import type { CalendarEventEntity } from "@spiritdevs/client-runtime/sync";
import { useEffect, useMemo, useState } from "react";

import { useSyncedCalendarEvents } from "~/cloud/calendarReadModel";

const DELIVERED_KEY = "pathway:calendar-alerts:delivered:v1";
const DELIVERY_GRACE_MS = 60_000;
const MAX_TIMER_MS = 2_147_000_000;
let audioContext: AudioContext | null = null;

export async function primeCalendarAlerts(): Promise<void> {
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    await Notification.requestPermission().catch(() => "denied" as const);
  }
  if (typeof AudioContext === "undefined") return;
  audioContext ??= new AudioContext();
  if (audioContext.state === "suspended") await audioContext.resume().catch(() => undefined);
}

interface CalendarAlertOccurrence {
  readonly id: string;
  readonly event: CalendarEventEntity;
  readonly minutesBefore: number;
  readonly dueAt: number;
}

export function calendarAlertOccurrences(
  events: ReadonlyArray<CalendarEventEntity>,
  now: number,
): ReadonlyArray<CalendarAlertOccurrence> {
  const occurrences: CalendarAlertOccurrence[] = [];
  for (const event of events) {
    const leadTimes = new Set(event.reminderMinutes);
    leadTimes.add(0);
    for (const minutesBefore of leadTimes) {
      const dueAt = event.startAt - minutesBefore * 60_000;
      if (dueAt < now - DELIVERY_GRACE_MS) continue;
      occurrences.push({
        id: `${event.id}:${event.updatedAt}:${minutesBefore}`,
        event,
        minutesBefore,
        dueAt,
      });
    }
  }
  return occurrences.sort((left, right) => left.dueAt - right.dueAt);
}

function deliveredIds(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(DELIVERED_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function markDelivered(id: string): void {
  const next = [...deliveredIds().filter((item) => item !== id), id].slice(-500);
  localStorage.setItem(DELIVERED_KEY, JSON.stringify(next));
}

function playAlertSound(): void {
  if (typeof AudioContext === "undefined") return;
  audioContext ??= new AudioContext();
  if (audioContext.state !== "running") return;
  const start = audioContext.currentTime;
  for (const [index, frequency] of [660, 880].entries()) {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start + index * 0.18);
    gain.gain.exponentialRampToValueAtTime(0.16, start + index * 0.18 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + index * 0.18 + 0.14);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(start + index * 0.18);
    oscillator.stop(start + index * 0.18 + 0.15);
  }
}

async function deliver(occurrence: CalendarAlertOccurrence): Promise<void> {
  const run = () => {
    if (deliveredIds().includes(occurrence.id)) return;
    markDelivered(occurrence.id);
    playAlertSound();
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const body =
      occurrence.minutesBefore === 0
        ? "Starting now"
        : occurrence.minutesBefore < 60
          ? `Starts in ${occurrence.minutesBefore} minutes`
          : occurrence.minutesBefore === 60
            ? "Starts in 1 hour"
            : `Starts in ${occurrence.minutesBefore / 60} hours`;
    const notification = new Notification(occurrence.event.title, {
      body: occurrence.event.location === null ? body : `${body} · ${occurrence.event.location}`,
      tag: occurrence.id,
    });
    void notification;
  };
  if (navigator.locks === undefined) {
    run();
    return;
  }
  await navigator.locks.request(`calendar-alert:${occurrence.id}`, run);
}

/** One timer for the next occurrence, mounted above the router so navigation cannot cancel it. */
export function CalendarAlertHost() {
  const events = useSyncedCalendarEvents();
  const [revision, setRevision] = useState(0);
  const next = useMemo(
    () =>
      calendarAlertOccurrences(events, Date.now()).find(
        (item) => !deliveredIds().includes(item.id),
      ) ?? null,
    [events, revision],
  );

  useEffect(() => {
    if (next === null) return;
    const delay = Math.max(0, Math.min(MAX_TIMER_MS, next.dueAt - Date.now()));
    const timer = window.setTimeout(() => {
      if (next.dueAt - Date.now() > 1_000) {
        setRevision((current) => current + 1);
        return;
      }
      void deliver(next).finally(() => setRevision((current) => current + 1));
    }, delay);
    return () => window.clearTimeout(timer);
  }, [next]);

  return null;
}
