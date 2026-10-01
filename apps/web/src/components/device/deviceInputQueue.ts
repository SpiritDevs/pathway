import type { DeviceInput } from "@spiritdevs/contracts";

const CROWN_LIMIT = 200;
const MAX_PENDING_PRESSES = 8;

type Press = Exclude<DeviceInput, { kind: "digitalCrown" } | { kind: "touch" }>;

/**
 * Serializes semantic device input, one request in flight. Crown deltas sum
 * until the next animation frame (or the in-flight request) and go out as
 * one bounded delta. Presses beyond a small backlog are dropped, so held keys
 * cannot queue minutes of repeats. `cancel` forgets everything unsent.
 */
export function createDeviceInputQueue(options: {
  readonly send: (input: DeviceInput) => Promise<boolean>;
  readonly requestFrame: (callback: () => void) => () => void;
}) {
  let presses: Press[] = [];
  let crown = 0;
  let crownReady = false;
  let cancelFrame: (() => void) | null = null;
  let inFlight = false;
  let generation = 0;

  const pump = () => {
    if (inFlight) return;
    let next: DeviceInput | undefined = presses.shift();
    if (!next && crownReady) {
      const delta = Math.max(-CROWN_LIMIT, Math.min(CROWN_LIMIT, Math.round(crown)));
      crown = delta === 0 ? 0 : crown - delta;
      crownReady = crown !== 0;
      if (delta !== 0) next = { kind: "digitalCrown", delta };
    }
    if (!next) return;
    inFlight = true;
    const current = generation;
    void options.send(next).then((ok) => {
      if (current !== generation) return;
      inFlight = false;
      // A failed press must not be followed by stale ones the user no longer expects.
      if (!ok) presses = [];
      pump();
    });
  };

  return {
    press(input: Press) {
      if (presses.length >= MAX_PENDING_PRESSES) return;
      presses.push(input);
      pump();
    },
    turnCrown(delta: number) {
      if (!Number.isFinite(delta) || delta === 0) return;
      crown += delta;
      if (crownReady || cancelFrame) return;
      cancelFrame = options.requestFrame(() => {
        cancelFrame = null;
        crownReady = true;
        pump();
      });
    },
    cancel() {
      generation++;
      presses = [];
      crown = 0;
      crownReady = false;
      inFlight = false;
      cancelFrame?.();
      cancelFrame = null;
    },
  };
}

export type DeviceInputQueue = ReturnType<typeof createDeviceInputQueue>;
