import { type ConnectOptions, type ConnectorHandle, startConnector } from "@cyndrbase/connect";
import type { RelayClientStatus } from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeURL from "node:url";
import { HostProcessArchitecture, HostProcessPlatform } from "./hostProcess.ts";

export type { ConnectorHandle, RelayClientStatus };

const decodePackageJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);
export type RelayClientStartOptions = Omit<ConnectOptions, "executablePath">;

export class RelayClientStartError extends Data.TaggedError("RelayClientStartError")<{
  readonly cause: unknown;
}> {}

export interface RelayClientShape {
  /** Whether this platform's bundled connector is present and executable. */
  readonly resolve: Effect.Effect<RelayClientStatus>;
  /** Starts the bundled connector. It reconnects on its own and exits once its token is rejected. */
  readonly start: (
    options: RelayClientStartOptions,
  ) => Effect.Effect<ConnectorHandle, RelayClientStartError>;
}

export class RelayClient extends Context.Service<RelayClient, RelayClientShape>()(
  "@spiritdevs/shared/relayClient",
) {}

/**
 * The connector executable that ships inside `@cyndrbase/connect`. Electron cannot spawn
 * files inside app.asar, so packaged desktop builds unpack it beside the archive.
 */
export function bundledConnectorPath(
  packageEntryUrl: string,
  platform: NodeJS.Platform,
  arch: string,
): string {
  const filename = platform === "win32" ? "cyndrbase-connector.exe" : "cyndrbase-connector";
  return NodeURL.fileURLToPath(
    new URL(`../bin/${platform}-${arch}/${filename}`, packageEntryUrl),
  ).replace(/([\\/])app\.asar(?=[\\/])/u, "$1app.asar.unpacked");
}

export const make = Effect.fn("relayClient.make")(function* (packageEntryUrl: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const executablePath = bundledConnectorPath(packageEntryUrl, platform, arch);
  const version = yield* fileSystem
    .readFileString(NodeURL.fileURLToPath(new URL("../package.json", packageEntryUrl)))
    .pipe(
      Effect.map((json) =>
        Option.match(decodePackageJson(json), {
          onNone: () => "unknown",
          onSome: (packageJson) => packageJson.version,
        }),
      ),
      Effect.orElseSucceed(() => "unknown"),
    );

  const resolve: RelayClientShape["resolve"] = fileSystem.stat(executablePath).pipe(
    Effect.option,
    Effect.map((info) =>
      Option.isSome(info) &&
      info.value.type === "File" &&
      (platform === "win32" || (info.value.mode & 0o111) !== 0)
        ? { status: "available", executablePath, source: "managed", version }
        : { status: "unsupported", platform, arch, version },
    ),
  );

  const start: RelayClientShape["start"] = (options) =>
    Effect.try({
      try: () => startConnector({ ...options, executablePath }),
      catch: (cause) => new RelayClientStartError({ cause }),
    });

  return RelayClient.of({ resolve, start });
});

export const layer = Layer.effect(
  RelayClient,
  Effect.suspend(() => make(import.meta.resolve("@cyndrbase/connect"))),
);
