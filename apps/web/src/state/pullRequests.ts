import { useAtomValue } from "@effect/atom-react";
import { createPullRequestEnvironmentAtoms } from "@t3tools/client-runtime/state/pull-requests";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { deriveActivePullRequestReviewKeys } from "../lib/pullRequestReviewActivity";
import { environmentThreadShells } from "./threads";

export const pullRequestEnvironment = createPullRequestEnvironmentAtoms(connectionAtomRuntime);

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
