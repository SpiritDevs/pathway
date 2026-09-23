import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(pathwayHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(pathwayHome)) {
    return Option.none();
  }
  const trimmed = pathwayHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

const comparablePath = (value: string, homeDirectory: string, joinPath: JoinPath): string => {
  const expanded =
    value === "~" || value.startsWith("~/") || value.startsWith("~\\")
      ? joinPath(homeDirectory, value.slice(1))
      : joinPath(value);
  return expanded.replace(/[\\/]+$/, "").toLowerCase();
};

/**
 * The PATHWAY_HOME an isolated flavor may adopt. An isolated flavor never shares the production
 * home, so a PATHWAY_HOME that resolves to `~/.pathway` is ignored and the flavor keeps its own
 * default; any other override still wins.
 */
export function resolveFlavorPathwayHome(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly pathwayHome: Option.Option<string>;
  readonly isolated: boolean;
}): Option.Option<string> {
  const configured = normalizeConfiguredBaseDir(input.pathwayHome);
  if (!input.isolated || Option.isNone(configured)) {
    return configured;
  }
  const productionHome = comparablePath(
    input.joinPath(input.homeDirectory, ".pathway"),
    input.homeDirectory,
    input.joinPath,
  );
  return comparablePath(configured.value, input.homeDirectory, input.joinPath) === productionHome
    ? Option.none()
    : configured;
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
