import {
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  EMPTY_TERMINAL_SESSION_STATE,
  type KnownTerminalSession,
  type TerminalSessionState,
} from "@spiritdevs/client-runtime/state/terminal";
import { useAtomValue } from "@effect/atom-react";
import {
  ThreadId,
  type EnvironmentId,
  type TerminalAttachInput,
  type TerminalSummary,
} from "@spiritdevs/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { useEnvironmentQuery } from "./query";
import { terminalEnvironment } from "./terminal";

const EMPTY_SUMMARIES: ReadonlyArray<TerminalSummary> = [];
const summariesByThread = new WeakMap<
  ReadonlyArray<TerminalSummary>,
  ReadonlyMap<string, ReadonlyArray<TerminalSummary>>
>();

// One index per metadata snapshot, so every thread's lookup stays O(1) as terminals stream.
function threadTerminalSummaries(
  summaries: ReadonlyArray<TerminalSummary>,
  threadId: string,
): ReadonlyArray<TerminalSummary> {
  let index = summariesByThread.get(summaries);
  if (index === undefined) {
    const next = new Map<string, TerminalSummary[]>();
    for (const summary of summaries) {
      const list = next.get(summary.threadId);
      if (list) list.push(summary);
      else next.set(summary.threadId, [summary]);
    }
    index = next;
    summariesByThread.set(summaries, index);
  }
  return index.get(threadId) ?? EMPTY_SUMMARIES;
}

const compareTerminalIds = (left: string, right: string) =>
  left.localeCompare(right, undefined, { numeric: true });

const EMPTY_TERMINAL_IDS: ReadonlyArray<string> = [];
const sameTerminalIds = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

// Scoped per thread: a metadata update only re-renders threads whose running terminals changed.
export const threadRunningTerminalIdsAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, string];
  return Atom.make((get) => {
    const summaries = Option.getOrNull(
      AsyncResult.value(get(terminalEnvironment.metadata({ environmentId, input: null }))),
    );
    if (summaries === null) return EMPTY_TERMINAL_IDS;
    const ids = threadTerminalSummaries(summaries, threadId)
      .filter((summary) => summary.hasRunningSubprocess)
      .map((summary) => summary.terminalId)
      .sort(compareTerminalIds);
    return ids.length === 0 ? EMPTY_TERMINAL_IDS : ids;
  }).pipe(Atom.withEquality(sameTerminalIds));
});

const NO_TERMINAL_IDS_ATOM = Atom.make(EMPTY_TERMINAL_IDS);

export function useAttachedTerminalSession(input: {
  readonly environmentId: EnvironmentId | null;
  readonly terminal: TerminalAttachInput | null;
  readonly preview?: boolean;
}): TerminalSessionState {
  const attach = useEnvironmentQuery(
    input.environmentId !== null && input.terminal !== null
      ? (input.preview ? terminalEnvironment.previewAttach : terminalEnvironment.attach)({
          environmentId: input.environmentId,
          input: input.terminal,
        })
      : null,
  );
  const metadata = useEnvironmentQuery(
    input.environmentId === null
      ? null
      : terminalEnvironment.metadata({
          environmentId: input.environmentId,
          input: null,
        }),
  );

  return useMemo(() => {
    if (input.environmentId === null || input.terminal === null) {
      return EMPTY_TERMINAL_SESSION_STATE;
    }
    const summary =
      metadata.data?.find(
        (terminal) =>
          terminal.threadId === input.terminal?.threadId &&
          terminal.terminalId === input.terminal?.terminalId,
      ) ?? null;
    const state = combineTerminalSessionState(summary, attach.data ?? EMPTY_TERMINAL_BUFFER_STATE);
    return attach.error === null ? state : { ...state, error: attach.error, status: "error" };
  }, [attach.data, attach.error, input.environmentId, input.terminal, metadata.data]);
}

export function useKnownTerminalSessions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<KnownTerminalSession> {
  const metadata = useEnvironmentQuery(
    input.environmentId === null
      ? null
      : terminalEnvironment.metadata({
          environmentId: input.environmentId,
          input: null,
        }),
  );
  return useMemo(() => {
    if (input.environmentId === null) {
      return [];
    }
    const summaries = metadata.data ?? EMPTY_SUMMARIES;
    return (
      input.threadId === null ? summaries : threadTerminalSummaries(summaries, input.threadId)
    )
      .map((summary) => ({
        target: {
          environmentId: input.environmentId!,
          threadId: ThreadId.make(summary.threadId),
          terminalId: summary.terminalId,
        },
        state: combineTerminalSessionState(summary, EMPTY_TERMINAL_BUFFER_STATE),
      }))
      .sort((left, right) => compareTerminalIds(left.target.terminalId, right.target.terminalId));
  }, [input.environmentId, input.threadId, metadata.data]);
}

export function useThreadRunningTerminalIds(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<string> {
  return useAtomValue(
    input.environmentId === null || input.threadId === null
      ? NO_TERMINAL_IDS_ATOM
      : threadRunningTerminalIdsAtom(JSON.stringify([input.environmentId, input.threadId])),
  );
}
