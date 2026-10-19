import {
  ComputerId,
  ThreadId,
  type ComputerHealth,
  type ThreadComputerState,
} from "@spiritdevs/contracts";

/** A connected, idle, visible-desktop thread state for Computer client tests. */
export function connectedComputerHealth(): ComputerHealth {
  return { status: "connected", consecutiveFailures: 0, reconnects: 0, captureAvailable: true };
}

export function threadComputerState(
  overrides: Partial<ThreadComputerState> = {},
): ThreadComputerState {
  return {
    threadId: ThreadId.make("thread-1"),
    version: 1,
    computerId: ComputerId.make("desktop"),
    capabilities: {
      windows: true,
      windowBounds: true,
      stacking: true,
      capture: true,
      input: true,
      clipboard: true,
      focus: true,
      raise: true,
      ghostCursor: true,
      visibleDesktop: true,
    },
    windows: [],
    screenSize: { width: 5120, height: 2520 },
    agentActive: false,
    controlledByOtherThread: false,
    availability: { kind: "available" },
    health: connectedComputerHealth(),
    lastError: null,
    ...overrides,
  } as ThreadComputerState;
}
