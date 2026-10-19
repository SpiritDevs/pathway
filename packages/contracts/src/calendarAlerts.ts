/** Alert subscriptions include the longest supported lead time and room for window renewal. */
export const MAX_CALENDAR_REMINDER_MINUTES = 40_320;
export const CALENDAR_ALERT_WINDOW_MS = (MAX_CALENDAR_REMINDER_MINUTES + 60) * 60_000;
