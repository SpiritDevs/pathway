import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

/** The two native executables the Computer host runs. P1 builds and packages both. */
export type ComputerBinary = "pathway-helper" | "cua-driver";

/** Each binary lives in a resources directory of the same name. */
export const computerBinaryFileName = (binary: ComputerBinary, platform: NodeJS.Platform) =>
  binary === "cua-driver" && platform === "win32" ? "cua-driver.exe" : binary;

/** Candidate paths in priority order. Development uses the P1 build output under
 * `apps/desktop/.electron-runtime`; packaged apps use `Contents/Resources/<binary>/`. */
export const computerBinaryCandidates = (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  binary: ComputerBinary,
): ReadonlyArray<string> => {
  const relative = environment.path.join(
    binary,
    computerBinaryFileName(binary, environment.platform),
  );
  if (environment.isDevelopment)
    return [environment.path.join(environment.rootDir, "apps/desktop/.electron-runtime", relative)];
  if (environment.isPackaged) return [environment.path.join(environment.resourcesPath, relative)];
  return environment.resolveResourcePathCandidates(relative);
};

/** Resolves the first existing candidate, or none when the binary is not built or not shipped. */
export const resolveComputerBinary = Effect.fn("desktop.computer.resolveComputerBinary")(function* (
  binary: ComputerBinary,
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  for (const candidate of computerBinaryCandidates(environment, binary)) {
    if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false)))
      return Option.some(candidate);
  }
  return Option.none<string>();
});
