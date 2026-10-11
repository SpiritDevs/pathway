import { useEffect, useState } from "react";
import type { DeviceControlLease } from "./useDeviceControlLease";

/** Who the viewer sees in control: themselves or this thread's agent. */
export type DeviceControlMode = "you" | "agent";

/**
 * Control is the viewer's by default. While this thread's agent is idle the viewer holds the
 * device without asking; while it works the viewer steps aside so the agent can take it, unless
 * they took control mid-turn. Choosing the agent while it is idle hands the device back and asks
 * the agent to continue.
 */
export function useDeviceControlMode(input: {
  readonly lease: DeviceControlLease;
  readonly threadId: string;
  readonly visible: boolean;
  readonly agentWorking: boolean;
  /** Starts the thread's continuation; resolves false when it could not start. */
  readonly onResumeAgent?: (() => Promise<boolean>) | undefined;
}) {
  const { lease, threadId, visible, agentWorking, onResumeAgent } = input;
  const { view } = lease;
  // The viewer took control during the agent's turn, so it stays theirs until handed back.
  const [kept, setKept] = useState(false);
  // Released for the agent, whose new turn has not shown as working yet.
  const [handingOff, setHandingOff] = useState(false);
  useEffect(() => {
    if (agentWorking) setHandingOff(false);
    else setKept(false);
  }, [agentWorking]);

  const agentTurn = agentWorking || handingOff;
  const busy = lease.acquiring || lease.releasing || lease.error !== null;
  const { take, release } = lease;
  useEffect(() => {
    if (!visible || busy) return;
    if (!agentTurn && view.kind === "none") void take();
    else if (agentTurn && !kept && view.kind === "you") void release();
  }, [agentTurn, busy, kept, release, take, view.kind, visible]);

  const mode: DeviceControlMode | null =
    view.kind === "you"
      ? "you"
      : (view.kind === "agent" && view.threadId === threadId) || (view.kind === "none" && agentTurn)
        ? "agent"
        : null;

  const chooseYou = () => {
    if (agentWorking) setKept(true);
    setHandingOff(false);
    void take();
  };
  const chooseAgent = async () => {
    setKept(false);
    if (agentWorking) {
      await release();
      return;
    }
    if (!onResumeAgent) return;
    setHandingOff(true);
    // The continuation's device_open needs the lease released and drained first.
    const started = (await release()) && (await onResumeAgent());
    if (!started) setHandingOff(false);
  };

  return {
    mode,
    agentTurn,
    /** The agent can only be chosen when it is working or there is a way to resume it. */
    canChooseAgent: agentWorking || onResumeAgent !== undefined,
    chooseYou,
    chooseAgent,
  };
}

export type DeviceControlModeState = ReturnType<typeof useDeviceControlMode>;
