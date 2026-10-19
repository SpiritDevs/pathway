import {
  Pathway_PROJECT_FILE_NAME,
  type EnvironmentId,
  type PathwayProjectFile,
  type PathwayProjectFileScript,
} from "@spiritdevs/contracts";
import { parsePathwayProjectFile } from "@spiritdevs/shared/pathwayProjectFile";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<PathwayProjectFileScript> = [];

export interface PathwayProjectFileState {
  /**
   * - `valid`: pathway.json exists and decoded.
   * - `invalid`: pathway.json exists but fails to decode (the server then ignores
   *   the whole file, including `iconPath` and every script).
   * - `missing`: no readable pathway.json at the workspace root.
   * - `loading`: the file query has not settled yet.
   */
  status: "loading" | "missing" | "invalid" | "valid";
  /** The decoded file when status is `valid`, null otherwise. */
  file: PathwayProjectFile | null;
  scripts: ReadonlyArray<PathwayProjectFileScript>;
}

/**
 * Decoded state of the project's checked-in `pathway.json`, including whether the
 * file exists but is broken — which the runtime otherwise swallows silently.
 */
export function usePathwayProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): PathwayProjectFileState {
  const query = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    Pathway_PROJECT_FILE_NAME,
    cwd !== null,
  );
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  return useMemo(() => {
    if (contents === null) {
      return {
        status: isPending ? "loading" : "missing",
        file: null,
        scripts: NO_SCRIPTS,
      } as const;
    }
    const file = parsePathwayProjectFile(contents);
    if (file === null) {
      return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
    }
    return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
  }, [contents, isPending]);
}

/**
 * Scripts declared in the project's checked-in `pathway.json`, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to
 * an empty list.
 */
export function usePathwayProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<PathwayProjectFileScript> {
  return usePathwayProjectFileState(environmentId, cwd).scripts;
}
