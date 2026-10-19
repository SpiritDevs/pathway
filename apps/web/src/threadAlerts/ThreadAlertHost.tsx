import { randomUUID } from "../lib/utils";
import { useEffect, useRef } from "react";
import {
  alertDeliveryThreadKey,
  createThreadAlertLeadership,
  isInAlertQuietHours,
  type AlertDeliveryEvent,
} from "@spiritdevs/client-runtime/thread-alerts";
import type { AlertDeliverySettings, ThreadAlertTarget } from "@spiritdevs/contracts/threadAlerts";
import { stopAlertSound, unlockAlertAudio } from "./audio";
import { clearThreadAlerts, deliverThreadAlert } from "./delivery";
import { claimAlertDelivery, releaseAlertLease, updateAlertPresence } from "./storage";

export interface ThreadAlertHostProps {
  readonly userId: string;
  readonly ready: boolean;
  readonly connected: boolean;
  readonly notifications: readonly AlertDeliveryEvent[];
  readonly settings: AlertDeliverySettings;
  readonly focusedThread: { readonly environmentId: string; readonly threadId: string } | null;
  readonly isEligible: (event: AlertDeliveryEvent) => boolean | null;
  readonly onNavigate: (target: ThreadAlertTarget) => void;
}

/** One owner delivers per browser installation. Other tabs publish their focused thread. */
export function ThreadAlertHost(props: ThreadAlertHostProps) {
  const latest = useRef(props);
  latest.current = props;
  const wake = useRef<(() => void) | null>(null);
  useEffect(() => {
    wake.current?.();
  });

  useEffect(() => {
    if (!props.userId) return;
    const userId = props.userId;
    const owner = randomUUID();
    let disposed = false;
    let active = false;
    let owned = false;
    let running = false;
    let rerun = false;
    let catchUp = true;
    let catchUpBefore = Date.now();
    let lastRun = Date.now();
    let wasConnected = latest.current.connected;

    const presence = () =>
      updateAlertPresence(
        userId,
        owner,
        document.hasFocus() &&
          document.visibilityState === "visible" &&
          latest.current.focusedThread
          ? alertDeliveryThreadKey(latest.current.focusedThread)
          : null,
      );

    const cycle = async () => {
      if (disposed) return;
      if (running) {
        rerun = true;
        return;
      }
      running = true;
      try {
        await presence();
        const current = latest.current;
        void leadership.setConnected(current.connected);
        if (!current.connected) {
          catchUp = true;
          wasConnected = false;
          return;
        }
        if (!wasConnected || Date.now() - lastRun > 30_000) {
          catchUp = true;
          catchUpBefore = Date.now();
        }
        wasConnected = true;
        lastRun = Date.now();
        if (!active || !current.ready || disposed) return;
        const result = await claimAlertDelivery(userId, owner, {
          events: current.notifications,
          now: lastRun,
          quiet: isInAlertQuietHours(current.settings.quietHours, new Date(lastRun)),
          catchUp: catchUp || !owned,
          catchUpBefore,
          eligible: (event) =>
            latest.current.ready && latest.current.userId === userId
              ? latest.current.isEligible(event)
              : null,
        });
        if (!result) {
          owned = false;
          catchUp = true;
          return;
        }
        owned = true;
        catchUp = false;
        if (disposed) return;
        for (const action of result.actions) {
          if (action.type === "event" && !latest.current.isEligible(action.event)) continue;
          void deliverThreadAlert(
            userId,
            latest.current.settings,
            action,
            (target) => {
              if (!disposed) latest.current.onNavigate(target);
            },
            () => !disposed && latest.current.userId === userId && latest.current.ready,
          );
        }
      } catch {
        // Storage failure must not fall back to delivery without a durable claim.
        catchUp = true;
      } finally {
        running = false;
        if (rerun && !disposed) {
          rerun = false;
          void cycle();
        }
      }
    };
    const schedule = () => {
      void cycle();
    };
    const resume = () => {
      catchUp = true;
      catchUpBefore = Date.now();
      schedule();
    };
    const visibility = () => {
      if (document.visibilityState === "visible") resume();
      else schedule();
    };
    const offline = () => {
      wasConnected = false;
      catchUp = true;
    };
    const clickUnsubscribe = window.desktopBridge?.threadAlerts?.onClick(userId, (target) => {
      if (!disposed && latest.current.userId === userId) latest.current.onNavigate(target);
    });
    wake.current = schedule;
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", schedule);
    window.addEventListener("blur", schedule);
    window.addEventListener("online", resume);
    window.addEventListener("offline", offline);
    window.addEventListener("pageshow", resume);
    window.addEventListener("pointerdown", unlockAlertAudio);
    window.addEventListener("keydown", unlockAlertAudio);
    // Also renews fallback leases and checks quiet-hours boundaries without rendering the UI.
    const timer = window.setInterval(schedule, 5_000);
    const leadership = createThreadAlertLeadership({
      name: `pathway-thread-alerts:${userId}`,
      locks: navigator.locks,
      onChange: (leader) => {
        active = leader;
        if (!leader) {
          owned = false;
          catchUp = true;
        } else schedule();
      },
      releaseLease: () => releaseAlertLease(userId, owner),
    });
    schedule();
    return () => {
      disposed = true;
      wake.current = null;
      void leadership.dispose();
      clickUnsubscribe?.();
      stopAlertSound();
      clearThreadAlerts();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", schedule);
      window.removeEventListener("blur", schedule);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", offline);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("pointerdown", unlockAlertAudio);
      window.removeEventListener("keydown", unlockAlertAudio);
      // These queue behind an in-flight transaction, so a departing tab cannot renew afterward.
      void updateAlertPresence(userId, owner, null).catch(() => {});
    };
  }, [props.userId]);
  return null;
}
