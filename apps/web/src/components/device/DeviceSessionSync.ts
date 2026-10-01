import { useEffect, useRef } from "react";
import { scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import type { ScopedThreadRef } from "@spiritdevs/contracts";
import { deviceSurfaceId, useRightPanelStore } from "~/rightPanelStore";
import { useDeviceThreadSessions } from "~/state/device";

/** Discover agent-opened sessions without mounting a decoder or a 3D renderer. */
export function useDeviceSessionSync(ref: ScopedThreadRef | null) {
  const current = useDeviceThreadSessions(ref?.environmentId ?? null, ref?.threadId ?? null);
  const seen = useRef(new Map<string, Set<string>>());
  useEffect(() => {
    if (!ref || current === null) return;
    const key = scopedThreadKey(ref);
    const targets = current.sessions.flatMap((session) => {
      const device = current.devices.find(
        (candidate) => candidate.hostId === session.hostId && candidate.id === session.deviceId,
      );
      return device
        ? [
            {
              hostId: device.hostId,
              deviceId: device.id,
              platform: device.platform,
              name: device.name,
            },
          ]
        : [];
    });
    const previous = seen.current.get(key);
    seen.current.set(key, new Set(targets.map(deviceSurfaceId)));
    const panels = useRightPanelStore.getState();
    // Use session identity for removal even while a host refresh is waiting for device metadata.
    panels.reconcileDeviceSurfaces(
      ref,
      current.sessions.map((session) => ({ ...session, name: session.deviceId })),
    );
    // First snapshot establishes the baseline; reconnecting must not reopen dismissed tabs.
    if (!previous) return;
    for (const target of targets) {
      if (!previous.has(deviceSurfaceId(target))) panels.openDevice(ref, target);
    }
  }, [ref, current]);
}
