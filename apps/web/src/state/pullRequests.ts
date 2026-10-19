import { useAtomValue } from "@effect/atom-react";
import { createPullRequestEnvironmentAtoms } from "@spiritdevs/client-runtime/state/pull-requests";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestListEntry,
  PullRequestListInput,
  PullRequestListProjectError,
  PullRequestListResult,
  PullRequestListStatsResult,
  PullRequestRef,
} from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { deriveActivePullRequestReviewKeys } from "../lib/pullRequestReviewActivity";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadShells } from "./threads";

export const pullRequestEnvironment = createPullRequestEnvironmentAtoms(connectionAtomRuntime);

export interface PullRequestEnvironmentTarget {
  readonly environmentId: EnvironmentId;
  /** Omitted when this environment should contribute every project it knows. */
  readonly projectId?: ProjectId;
}

export interface SourcedPullRequestListEntry extends PullRequestListEntry {
  /** The environment whose checkout can answer detail reads and actions for this row. */
  readonly environmentId: EnvironmentId;
  /** Kept per row because two environments may authenticate as different users on one host. */
  readonly viewerLogin: string | null;
}

export interface SourcedPullRequestListProjectError extends PullRequestListProjectError {
  readonly environmentId: EnvironmentId;
}

export interface SourcedPullRequestListResult extends Omit<
  PullRequestListResult,
  "entries" | "errors"
> {
  readonly entries: ReadonlyArray<SourcedPullRequestListEntry>;
  readonly errors: ReadonlyArray<SourcedPullRequestListProjectError>;
}

interface PullRequestListAcrossEnvironmentsState {
  readonly data: SourcedPullRequestListResult | null;
  readonly isPending: boolean;
  readonly error: string | null;
}

interface PullRequestListAcrossEnvironmentsKey {
  readonly targets: ReadonlyArray<PullRequestEnvironmentTarget>;
  readonly input: PullRequestListInput;
}

const cursorPrefix = (environmentId: EnvironmentId) => `${environmentId}\u0000`;

function cursorsForEnvironment(
  cursors: PullRequestListInput["cursors"],
  environmentId: EnvironmentId,
): Record<string, string> | undefined {
  if (cursors === undefined) return undefined;
  const prefix = cursorPrefix(environmentId);
  const scoped = Object.fromEntries(
    Object.entries(cursors).flatMap(([key, value]) =>
      key.startsWith(prefix) ? [[key.slice(prefix.length), value] as const] : [],
    ),
  );
  return Object.keys(scoped).length === 0 ? undefined : scoped;
}

function listInputForTarget(
  input: PullRequestListInput,
  target: PullRequestEnvironmentTarget,
): PullRequestListInput {
  const cursors = cursorsForEnvironment(input.cursors, target.environmentId);
  return {
    ...input,
    ...(target.projectId === undefined ? {} : { projectId: target.projectId }),
    ...(cursors === undefined ? { cursors: undefined } : { cursors }),
  };
}

function pullRequestSourceKey(entry: PullRequestListEntry): string {
  return `${entry.host}:${entry.repository}#${entry.number}`;
}

function formatEnvironmentFailure(environmentId: EnvironmentId, cause: Cause.Cause<unknown>) {
  const failure = Cause.squash(cause);
  const detail =
    failure instanceof Error && failure.message.trim().length > 0
      ? failure.message
      : "The environment request failed.";
  return `${environmentId}: ${detail}`;
}

/**
 * Combines the environment-owned PR APIs into one workspace answer. Convex supplies the project
 * identity and environment bindings; the actual host data still comes directly from each
 * connected environment, so credentials and filesystem paths never leave their owner.
 */
export function combinePullRequestListResults(
  results: ReadonlyArray<{
    readonly target: PullRequestEnvironmentTarget;
    readonly data: PullRequestListResult;
  }>,
): SourcedPullRequestListResult {
  const viewers: Record<string, string> = {};
  const providers = new Map<string, PullRequestListResult["providers"][number]>();
  const entries = new Map<string, SourcedPullRequestListEntry>();
  const errors: SourcedPullRequestListProjectError[] = [];
  const nextCursors: Record<string, string> = {};
  let truncated = false;

  for (const { target, data } of results) {
    Object.assign(viewers, data.viewers);
    for (const provider of data.providers) {
      const key = `${provider.kind}:${provider.host}`;
      const current = providers.get(key);
      providers.set(
        key,
        current === undefined
          ? provider
          : {
              ...current,
              configured: current.configured || provider.configured,
              detail:
                current.configured || provider.configured
                  ? null
                  : (current.detail ?? provider.detail),
              projectCount: Math.max(current.projectCount, provider.projectCount),
              searchesOnHost: current.searchesOnHost && provider.searchesOnHost,
            },
      );
    }
    for (const entry of data.entries) {
      const key = pullRequestSourceKey(entry);
      if (entries.has(key)) continue;
      entries.set(key, {
        ...entry,
        environmentId: target.environmentId,
        viewerLogin: data.viewers[entry.host] ?? null,
      });
    }
    errors.push(...data.errors.map((error) => ({ ...error, environmentId: target.environmentId })));
    for (const [key, cursor] of Object.entries(data.nextCursors)) {
      nextCursors[`${cursorPrefix(target.environmentId)}${key}`] = cursor;
    }
    truncated ||= data.truncated;
  }

  return {
    viewers,
    providers: [...providers.values()],
    entries: [...entries.values()].toSorted((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    ),
    errors,
    truncated,
    nextCursors,
  };
}

const pullRequestListsAcrossEnvironmentsAtom = Atom.family((key: string) =>
  Atom.make((get): PullRequestListAcrossEnvironmentsState => {
    const request = JSON.parse(key) as PullRequestListAcrossEnvironmentsKey;
    const available: Array<{
      target: PullRequestEnvironmentTarget;
      data: PullRequestListResult;
    }> = [];
    const failures: string[] = [];
    let isPending = false;

    for (const target of request.targets) {
      const result = get(
        pullRequestEnvironment.list({
          environmentId: target.environmentId,
          input: listInputForTarget(request.input, target),
        }),
      );
      isPending ||= result.waiting;
      const value = Option.getOrNull(AsyncResult.value(result));
      if (value !== null) available.push({ target, data: value });
      if (result._tag === "Failure") {
        failures.push(formatEnvironmentFailure(target.environmentId, result.cause));
      }
    }

    return {
      data: available.length === 0 ? null : combinePullRequestListResults(available),
      isPending,
      error: failures.length === 0 ? null : failures.join("\n"),
    };
  }).pipe(Atom.withLabel(`web-pull-requests-across-environments:${key}`)),
);

export function usePullRequestListAcrossEnvironments(
  targets: ReadonlyArray<PullRequestEnvironmentTarget>,
  input: PullRequestListInput,
) {
  const key = useMemo(() => JSON.stringify({ targets, input }), [input, targets]);
  const state = useAtomValue(pullRequestListsAcrossEnvironmentsAtom(key));
  const refresh = useCallback(() => {
    for (const target of targets) {
      appAtomRegistry.refresh(
        pullRequestEnvironment.list({
          environmentId: target.environmentId,
          input: listInputForTarget(input, target),
        }),
      );
    }
  }, [input, targets]);
  return { ...state, refresh };
}

interface PullRequestStatsTarget {
  readonly environmentId: EnvironmentId;
  readonly refs: ReadonlyArray<PullRequestRef>;
}

interface PullRequestStatsAcrossEnvironmentsState {
  readonly data: PullRequestListStatsResult | null;
  readonly isPending: boolean;
  readonly error: string | null;
}

const pullRequestStatsAcrossEnvironmentsAtom = Atom.family((key: string) =>
  Atom.make((get): PullRequestStatsAcrossEnvironmentsState => {
    const targets = JSON.parse(key) as ReadonlyArray<PullRequestStatsTarget>;
    const stats: PullRequestListStatsResult["stats"][number][] = [];
    const failures: string[] = [];
    let isPending = false;
    let answered = false;
    for (const target of targets) {
      const result = get(
        pullRequestEnvironment.listStats({
          environmentId: target.environmentId,
          input: { refs: target.refs },
        }),
      );
      isPending ||= result.waiting;
      const value = Option.getOrNull(AsyncResult.value(result));
      if (value !== null) {
        answered = true;
        stats.push(...value.stats);
      }
      if (result._tag === "Failure") {
        failures.push(formatEnvironmentFailure(target.environmentId, result.cause));
      }
    }
    return {
      data: answered ? { stats } : null,
      isPending,
      error: failures.length === 0 ? null : failures.join("\n"),
    };
  }).pipe(Atom.withLabel(`web-pull-request-stats-across-environments:${key}`)),
);

export function usePullRequestStatsAcrossEnvironments(
  entries: ReadonlyArray<SourcedPullRequestListEntry>,
) {
  const targets = useMemo(() => {
    const byEnvironment = new Map<EnvironmentId, PullRequestRef[]>();
    for (const entry of entries) {
      const refs = byEnvironment.get(entry.environmentId) ?? [];
      refs.push({ projectId: entry.projectId, repository: entry.repository, number: entry.number });
      byEnvironment.set(entry.environmentId, refs);
    }
    return [...byEnvironment].map(([environmentId, refs]) => ({ environmentId, refs }));
  }, [entries]);
  const key = useMemo(() => JSON.stringify(targets), [targets]);
  const state = useAtomValue(pullRequestStatsAcrossEnvironmentsAtom(key));
  const refresh = useCallback(() => {
    for (const target of targets) {
      appAtomRegistry.refresh(
        pullRequestEnvironment.listStats({
          environmentId: target.environmentId,
          input: { refs: target.refs },
        }),
      );
    }
  }, [targets]);
  return { ...state, refresh };
}

const EMPTY_ACTIVE_REVIEW_KEYS: ReadonlySet<string> = new Set();
const EMPTY_ACTIVE_REVIEW_KEYS_ATOM = Atom.make(EMPTY_ACTIVE_REVIEW_KEYS).pipe(
  Atom.withLabel("web-active-pull-request-reviews:empty"),
);
const activeReviewKeysAtom = Atom.family((environmentId: EnvironmentId) => {
  let previous: ReadonlySet<string> = EMPTY_ACTIVE_REVIEW_KEYS;
  return Atom.make((get) => {
    const next = deriveActivePullRequestReviewKeys(
      get(environmentThreadShells.threadShellsAtom),
      environmentId,
    );
    if (next.size === previous.size && [...next].every((key) => previous.has(key))) {
      return previous;
    }
    previous = next.size === 0 ? EMPTY_ACTIVE_REVIEW_KEYS : next;
    return previous;
  }).pipe(Atom.withLabel(`web-active-pull-request-reviews:${environmentId}`));
});

export function useActivePullRequestReviewKeys(
  environmentId: EnvironmentId | null,
): ReadonlySet<string> {
  return useAtomValue(
    environmentId === null ? EMPTY_ACTIVE_REVIEW_KEYS_ATOM : activeReviewKeysAtom(environmentId),
  );
}

const activeReviewKeysAcrossEnvironmentsAtom = Atom.family((key: string) => {
  let previous: ReadonlySet<string> = EMPTY_ACTIVE_REVIEW_KEYS;
  return Atom.make((get) => {
    const environmentIds = JSON.parse(key) as ReadonlyArray<EnvironmentId>;
    const threads = get(environmentThreadShells.threadShellsAtom);
    const next = new Set<string>();
    for (const environmentId of environmentIds) {
      for (const reviewKey of deriveActivePullRequestReviewKeys(threads, environmentId)) {
        next.add(reviewKey);
      }
    }
    if (next.size === previous.size && [...next].every((reviewKey) => previous.has(reviewKey))) {
      return previous;
    }
    previous = next.size === 0 ? EMPTY_ACTIVE_REVIEW_KEYS : next;
    return previous;
  }).pipe(Atom.withLabel(`web-active-pull-request-reviews:all:${key}`));
});

export function useActivePullRequestReviewKeysForEnvironments(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlySet<string> {
  const key = useMemo(
    () => JSON.stringify(environmentIds.toSorted((left, right) => left.localeCompare(right))),
    [environmentIds],
  );
  return useAtomValue(activeReviewKeysAcrossEnvironmentsAtom(key));
}
