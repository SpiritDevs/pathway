import {
  ServerSelfUpdateError,
  type ServerSelfUpdateCapability,
  type ServerSelfUpdateInput,
  type ServerSelfUpdateProgressStage,
  type ServerSelfUpdateResult,
  type ServerUpdateCheckResult,
} from "@spiritdevs/contracts";
import { HostProcessExecutablePath } from "@spiritdevs/shared/hostProcess";
import { extractReleaseNoteItems } from "@spiritdevs/shared/releaseNotes";
import { compareSemverVersions } from "@spiritdevs/shared/semver";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };

import * as ServerConfig from "../config.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as ProcessRunner from "../processRunner.ts";
import { fetchNpmLatestVersion } from "../provider/providerMaintenance.ts";
import {
  ensurePinnedRuntimeInstalled,
  PinnedRuntimeInstallError,
  PinnedRuntimePreflightBlockedError,
} from "./pinnedRuntime.ts";
import { decodeServicePreflightResult } from "./servicePreflight.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { isExactServiceVersion, SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

const PREFLIGHT_TIMEOUT = Duration.seconds(30);
const RELEASE_NOTES_TIMEOUT = Duration.seconds(4);
const SERVER_PACKAGE = "@spiritdevs/pathway";

const GitHubRelease = Schema.Struct({ body: Schema.optional(Schema.NullOr(Schema.String)) });

/** Notes for one published release, or none when GitHub has none or is unreachable. */
const fetchReleaseNotes = Effect.fn("cloud.server_self_update.fetch_release_notes")(function* (
  version: string,
) {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(
    `https://api.github.com/repos/SpiritDevs/pathway/releases/tags/v${encodeURIComponent(version)}`,
  ).pipe(
    HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
    HttpClientRequest.setHeader("user-agent", "pathway-server"),
  );
  const release = yield* client.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(GitHubRelease)))
        : Effect.fail(response.status),
    ),
    Effect.timeoutOption(RELEASE_NOTES_TIMEOUT),
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(release)) return [];
  const items = extractReleaseNoteItems(release.value.body);
  return items.length > 0 ? [{ version, items }] : [];
});

/** Compares a service-managed server against the npm `latest` tag. */
export const checkPublishedServerUpdate = Effect.fn("cloud.server_self_update.check_published")(
  function* (currentVersion: string) {
    const latest = yield* fetchNpmLatestVersion(SERVER_PACKAGE);
    if (latest === null) {
      return yield* new ServerSelfUpdateError({
        reason: "Could not reach the npm registry to check for updates.",
      });
    }
    if (compareSemverVersions(latest, currentVersion) <= 0) {
      return { currentVersion, availableVersion: null, releaseNotes: [] };
    }
    return {
      currentVersion,
      availableVersion: latest,
      releaseNotes: yield* fetchReleaseNotes(latest),
    } satisfies ServerUpdateCheckResult;
  },
);

export function resolveServerSelfUpdateCapability(input: {
  readonly desktopManaged: boolean;
  readonly launcherManaged: boolean;
}): ServerSelfUpdateCapability | null {
  if (input.desktopManaged) return "desktop-managed" as const;
  return input.launcherManaged ? ("boot-service" as const) : null;
}

export class ServerSelfUpdate extends Context.Service<
  ServerSelfUpdate,
  {
    readonly update: (
      input: ServerSelfUpdateInput,
      reportProgress?: (stage: ServerSelfUpdateProgressStage) => Effect.Effect<void>,
    ) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
    readonly commitDesktopUpdate: (
      requestId: string,
    ) => Effect.Effect<never, ServerSelfUpdateError>;
    /** Reports whether a newer version is available, without changing anything. */
    readonly check: Effect.Effect<ServerUpdateCheckResult, ServerSelfUpdateError>;
  }
>()("@spiritdevs/pathway/cloud/selfUpdate/ServerSelfUpdate") {}

export const make = Effect.fn("cloud.server_self_update.make")(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const desktopAppUpdate = yield* DesktopAppUpdate.DesktopAppUpdate;
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const execPath = yield* HostProcessExecutablePath;
  const httpClient = yield* HttpClient.HttpClient;
  const inFlight = yield* Ref.make(false);

  const capability: ServerSelfUpdateCapability | null =
    serverConfig.mode === "desktop" ? "desktop-managed" : launcher.managed ? "boot-service" : null;
  const failWith = (reason: string, cause?: unknown) =>
    cause === undefined
      ? new ServerSelfUpdateError({ reason })
      : new ServerSelfUpdateError({ reason, cause });

  const update: ServerSelfUpdate["Service"]["update"] = Effect.fn(
    "cloud.server_self_update.update",
  )(function* (input, reportProgress = () => Effect.void) {
    if (capability === "desktop-managed") {
      // input.targetVersion is meaningless here: the desktop app's own
      // update feed decides what it downloads, and the result carries what
      // it actually got.
      if (desktopAppUpdate.available) {
        return yield* desktopAppUpdate.run(reportProgress);
      }
      return yield* failWith(
        "This server is managed by the Pathway desktop app on its machine; update the desktop app to update it.",
      );
    }
    if (capability === null) {
      return yield* failWith(
        "Remote updates require the Pathway background service. Run `pathway service install` on the server machine.",
      );
    }

    const targetVersion = input.targetVersion.trim();
    if (!isExactServiceVersion(targetVersion)) {
      return yield* failWith(`'${targetVersion}' is not an exact Pathway version.`);
    }
    if (yield* Ref.getAndSet(inFlight, true)) {
      return yield* failWith("A server update is already in progress.");
    }

    return yield* Effect.gen(function* () {
      yield* reportProgress("downloading");
      const paths = yield* ensurePinnedRuntimeInstalled({
        baseDir: serverConfig.baseDir,
        version: targetVersion,
        fs,
        path,
        runner,
        validate: (runtime) =>
          runner
            .run({
              command: execPath,
              args: [
                runtime.entryPath,
                "__service-preflight",
                "--database-path",
                serverConfig.dbPath,
                "--launcher-protocol",
                String(SERVICE_LAUNCHER_PROTOCOL),
              ],
              timeout: PREFLIGHT_TIMEOUT,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new PinnedRuntimeInstallError({
                    step: "running the staged service preflight",
                    cause,
                  }),
              ),
              Effect.flatMap(
                (
                  result,
                ): Effect.Effect<
                  void,
                  PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError
                > => {
                  if (result.code !== 0) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "running the staged service preflight",
                        exitCode: Number(result.code),
                        stdoutLength: result.stdout.length,
                        stderrLength: result.stderr.length,
                      }),
                    );
                  }
                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(result.stdout.trim());
                  } catch (cause) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "decoding the staged service preflight",
                        cause,
                      }),
                    );
                  }
                  const preflight = decodeServicePreflightResult(parsed);
                  if (preflight === undefined || preflight.version !== targetVersion) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "verifying the staged service preflight",
                      }),
                    );
                  }
                  return preflight.status === "ready"
                    ? Effect.void
                    : Effect.fail(
                        new PinnedRuntimePreflightBlockedError({
                          version: targetVersion,
                          reason: preflight.reason,
                        }),
                      );
                },
              ),
            ),
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "PinnedRuntimePreflightBlockedError"
            ? failWith(error.reason, error)
            : failWith(`Could not prepare @spiritdevs/pathway@${targetVersion}.`, error),
        ),
      );

      yield* reportProgress("installing");
      const updateId = yield* launcher
        .requestUpdate({ targetVersion, dbPath: serverConfig.dbPath })
        .pipe(
          Effect.mapError((error) =>
            failWith(
              error._tag === "ServiceLauncherRejectedError"
                ? error.reason
                : "Could not ask the service launcher to activate the prepared update.",
              error,
            ),
          ),
        );

      yield* Effect.logInfo("Server update prepared; handing off to the service launcher.", {
        updateId,
        targetVersion,
        runtimePath: paths.entryPath,
      });
      return { targetVersion, method: "boot-service" as const, updateId };
    }).pipe(Effect.onError(() => Ref.set(inFlight, false)));
  });

  // Desktop builds follow the desktop app's own update feed; everything else
  // follows the npm package that `update` installs.
  const check: ServerSelfUpdate["Service"]["check"] =
    capability === "desktop-managed"
      ? desktopAppUpdate.check
      : checkPublishedServerUpdate(packageJson.version).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        );

  return ServerSelfUpdate.of({
    update,
    commitDesktopUpdate: (requestId) => desktopAppUpdate.commit(requestId),
    check,
  });
});

export const layer = Layer.effect(ServerSelfUpdate, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
