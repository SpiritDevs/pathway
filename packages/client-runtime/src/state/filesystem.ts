import { type FilesystemBrowseEntry, WS_METHODS } from "@spiritdevs/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  canNavigateUp,
  ensureBrowseDirectoryPath,
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  getBrowseParentPath,
  hasTrailingPathSeparator,
  isFilesystemBrowseQuery,
} from "./projects.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function getFilesystemBrowsePath(query: string, platform = "", enabled = true) {
  const isBrowsing = enabled && isFilesystemBrowseQuery(query, platform);
  const directoryPath = isBrowsing ? getBrowseDirectoryPath(query) : "";
  const filterQuery =
    isBrowsing && !hasTrailingPathSeparator(query) ? getBrowseLeafPathSegment(query) : "";
  const parentPath = isBrowsing ? getBrowseParentPath(directoryPath) : null;

  return {
    isBrowsing,
    directoryPath,
    filterQuery,
    parentPath,
    canBrowseUp: isBrowsing && canNavigateUp(directoryPath),
  };
}

export function filterFilesystemBrowseEntries(
  entries: ReadonlyArray<FilesystemBrowseEntry>,
  query: string,
) {
  const lowerQuery = query.toLowerCase();
  const showHidden = query.startsWith(".");
  const visibleEntries = entries.filter(
    (entry) =>
      entry.name.toLowerCase().startsWith(lowerQuery) &&
      (showHidden || !entry.name.startsWith(".")),
  );
  const exactEntry =
    query.length > 0 ? (visibleEntries.find((entry) => entry.name === query) ?? null) : null;

  return { visibleEntries, exactEntry };
}

/**
 * Complete the leaf currently being browsed, like shell Tab completion.
 *
 * A sole match completes the directory and adds its trailing separator. Multiple matches advance
 * only through their shared prefix, leaving the user at the first character they need to choose.
 */
export function completeFilesystemBrowsePath(
  query: string,
  entries: ReadonlyArray<FilesystemBrowseEntry>,
): string | null {
  const leaf = getBrowseLeafPathSegment(query);
  const { visibleEntries } = filterFilesystemBrowseEntries(entries, leaf);
  const firstEntry = visibleEntries[0];
  if (!firstEntry) {
    return null;
  }

  let commonPrefixLength = firstEntry.name.length;
  for (const entry of visibleEntries.slice(1)) {
    const comparableLength = Math.min(commonPrefixLength, entry.name.length);
    let index = 0;
    while (
      index < comparableLength &&
      firstEntry.name[index]?.toLowerCase() === entry.name[index]?.toLowerCase()
    ) {
      index += 1;
    }
    commonPrefixLength = index;
  }

  const completedPath = `${getBrowseDirectoryPath(query)}${firstEntry.name.slice(0, commonPrefixLength)}`;
  const completion =
    visibleEntries.length === 1 ? ensureBrowseDirectoryPath(completedPath) : completedPath;
  return completion === query ? null : completion;
}

export function createBrowseNavigationCoordinator() {
  let generation = 0;

  return {
    invalidate: () => {
      generation += 1;
    },
    run: async (load: () => Promise<void>, commit: () => void) => {
      const navigationGeneration = ++generation;
      await load();
      if (navigationGeneration !== generation) {
        return false;
      }
      commit();
      return true;
    },
  };
}

export function canPreloadBrowsePath(
  connectionPhase: EnvironmentConnectionPhase | null | undefined,
): boolean {
  return connectionPhase === "connected";
}

export function createFilesystemEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    browse: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:filesystem:browse",
      tag: WS_METHODS.filesystemBrowse,
    }),
  };
}
