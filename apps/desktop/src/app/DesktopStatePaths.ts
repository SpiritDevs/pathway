import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(pathwayHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(pathwayHome)) {
    return Option.none();
  }
  const trimmed = pathwayHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

/**
 * The PATHWAY_HOME a flavor adopts. The isolated cua flavor exists so Computer Use testing never
 * touches another install's state, so it ignores PATHWAY_HOME and always uses its own home.
 */
export function resolveFlavorPathwayHome(input: {
  readonly pathwayHome: Option.Option<string>;
  readonly isolated: boolean;
}): Option.Option<string> {
  return input.isolated ? Option.none() : normalizeConfiguredBaseDir(input.pathwayHome);
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly pathwayHome: Option.Option<string>;
  readonly defaultHomeDirName?: string | undefined;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.pathwayHome), () =>
    input.joinPath(input.homeDirectory, input.defaultHomeDirName ?? ".pathway"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly pathwayHome: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.pathwayHome));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
