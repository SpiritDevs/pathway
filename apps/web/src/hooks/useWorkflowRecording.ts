import type { EnvironmentId, ThreadId, WorkflowRecordingStatus } from "@spiritdevs/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@spiritdevs/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { computerEnvironment } from "~/state/computer";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

/** Phases where the native helper is live and the status changes on its own. */
const ACTIVE_PHASES: ReadonlySet<WorkflowRecordingStatus["phase"]> = new Set([
  "awaiting-confirmation",
  "recording",
  "stopping",
]);
const ACTIVE_POLL_MS = 1_000;
// Another thread holds the recorder; re-check slowly so this one frees up.
const BUSY_POLL_MS = 5_000;

export const isWorkflowRecordingActive = (status: WorkflowRecordingStatus | null) =>
  status !== null && ACTIVE_PHASES.has(status.phase);

/** Whether this thread cannot start a recording right now (its own or another thread's). */
export const isWorkflowRecordingBlocked = (status: WorkflowRecordingStatus | null) =>
  isWorkflowRecordingActive(status) || status?.phase === "busy";

/**
 * Whether the environment's server runs on macOS, the only recorder platform.
 * Follows the server, not this device: a phone or browser records the host Mac.
 */
export function useWorkflowRecordingPlatform(environmentId: EnvironmentId | null): boolean {
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return serverConfig?.environment.platform.os === "darwin";
}

const WORKFLOW_RECORDING_START_EVENT = "pathway:workflow-recording-start";

export interface WorkflowRecordingTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/**
 * Asks the thread's composer to start a recording, so every entry point (the
 * command palette included) goes through the composer's one start path.
 */
export function requestWorkflowRecordingStart(target: WorkflowRecordingTarget): void {
  window.dispatchEvent(new CustomEvent(WORKFLOW_RECORDING_START_EVENT, { detail: target }));
}

export function onWorkflowRecordingStartRequested(
  listener: (target: WorkflowRecordingTarget) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<WorkflowRecordingTarget>).detail);
  };
  window.addEventListener(WORKFLOW_RECORDING_START_EVENT, handler);
  return () => window.removeEventListener(WORKFLOW_RECORDING_START_EVENT, handler);
}

type RecordingCommand = "start" | "stop" | "cancel";

export interface WorkflowRecordingController {
  /** Null until the first read, and always null for drafts. */
  readonly status: WorkflowRecordingStatus | null;
  readonly error: string | null;
  readonly pending: RecordingCommand | null;
  readonly start: () => void;
  readonly stop: () => void;
  /** Cancels a live recording, or discards a completed one. */
  readonly cancel: () => void;
  readonly clearError: () => void;
}

const describeFailure = (outcome: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(outcome);
  return error instanceof Error && error.message
    ? error.message
    : "Could not reach the recorder. Try again.";
};

/**
 * Record a skill for one durable thread. Reads the status once per thread,
 * then every second only while a recording is live and the window is visible,
 * one request at a time. Returning to the window re-reads it.
 */
export function useWorkflowRecording(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): WorkflowRecordingController {
  const { environmentId, threadId } = input;
  const readStatus = useAtomCommand(computerEnvironment.recordingStatus, { reportFailure: false });
  const startRecording = useAtomCommand(computerEnvironment.startRecording, {
    reportFailure: false,
  });
  const stopRecording = useAtomCommand(computerEnvironment.stopRecording, {
    reportFailure: false,
  });
  const cancelRecording = useAtomCommand(computerEnvironment.cancelRecording, {
    reportFailure: false,
  });
  const [status, setStatus] = useState<WorkflowRecordingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<RecordingCommand | null>(null);
  // Counts finished reads, so a failed or dropped read still re-arms the poll.
  const [reads, setReads] = useState(0);
  // Bumped on thread change and around every command, so a read that raced
  // either is dropped instead of overwriting the newer status.
  const version = useRef(0);
  // The read in flight, if any. Only that read may release it.
  const reading = useRef<object | null>(null);

  const refresh = useCallback(() => {
    if (!environmentId || !threadId || reading.current) return;
    const read = {};
    const current = version.current;
    reading.current = read;
    void readStatus({ environmentId, input: { threadId } }).then((outcome) => {
      if (reading.current === read) reading.current = null;
      // Counted even when dropped, so the poll re-arms after a raced read.
      setReads((count) => count + 1);
      if (current !== version.current) return;
      if (outcome._tag === "Success") {
        setStatus(outcome.value);
        setError(null);
        return;
      }
      // Keep the last known status so live Stop/Cancel stay reachable.
      if (!isAtomCommandInterrupted(outcome)) setError(describeFailure(outcome));
    });
  }, [environmentId, readStatus, threadId]);

  useEffect(() => {
    version.current += 1;
    reading.current = null;
    setStatus(null);
    setError(null);
    setPending(null);
    refresh();
  }, [refresh]);

  // Live phases include native Stop/Cancel on the Mac, so the read continues
  // until the status settles (completed, cancelled, failed, idle).
  const pollMs = isWorkflowRecordingActive(status)
    ? ACTIVE_POLL_MS
    : status?.phase === "busy"
      ? BUSY_POLL_MS
      : null;
  useEffect(() => {
    if (pollMs === null) return;
    // Re-armed by each status reply, so reads never overlap.
    const timeout = setTimeout(() => {
      if (document.visibilityState !== "hidden") refresh();
    }, pollMs);
    return () => clearTimeout(timeout);
  }, [pollMs, reads, refresh, status]);

  useEffect(() => {
    const refreshOnReturn = () => {
      if (document.visibilityState !== "hidden") refresh();
    };
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => document.removeEventListener("visibilitychange", refreshOnReturn);
  }, [refresh]);

  const run = useCallback(
    (command: RecordingCommand) => {
      if (!environmentId || !threadId) return;
      const execute =
        command === "start" ? startRecording : command === "stop" ? stopRecording : cancelRecording;
      const current = ++version.current;
      setPending(command);
      setError(null);
      void execute({ environmentId, input: { threadId } }).then((outcome) => {
        if (current !== version.current) return;
        version.current += 1;
        setPending(null);
        if (outcome._tag === "Success") {
          setStatus(outcome.value);
          return;
        }
        if (!isAtomCommandInterrupted(outcome)) setError(describeFailure(outcome));
        refresh();
      });
    },
    [cancelRecording, environmentId, refresh, startRecording, stopRecording, threadId],
  );

  return {
    status,
    error,
    pending,
    start: useCallback(() => run("start"), [run]),
    stop: useCallback(() => run("stop"), [run]),
    cancel: useCallback(() => run("cancel"), [run]),
    clearError: useCallback(() => setError(null), []),
  };
}
