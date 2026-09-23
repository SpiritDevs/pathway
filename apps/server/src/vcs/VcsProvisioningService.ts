import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  type VcsDriverKind,
  type VcsError,
  type VcsInitInput,
  VcsProcessSpawnError,
  VcsUnsupportedOperationError,
} from "@spiritdevs/contracts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

export class VcsProvisioningService extends Context.Service<
  VcsProvisioningService,
  {
    readonly initRepository: (input: VcsInitInput) => Effect.Effect<void, VcsError>;
  }
>()("@spiritdevs/pathway/vcs/VcsProvisioningService") {}

function resolveRequestedKind(
  kind: VcsDriverKind | undefined,
): Effect.Effect<VcsDriverKind, VcsUnsupportedOperationError> {
  if (kind === undefined) {
    return Effect.succeed("git");
  }
  if (kind === "unknown") {
    return Effect.fail(
      new VcsUnsupportedOperationError({
        operation: "VcsProvisioningService.resolveRequestedKind",
        kind,
        detail: "A concrete VCS driver kind is required for repository provisioning.",
      }),
    );
  }
  return Effect.succeed(kind);
}

export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const createDirectory = (cwd: string) => {
    const expanded =
      cwd === "~"
        ? NodeOS.homedir()
        : cwd.startsWith("~/") || cwd.startsWith("~\\")
          ? path.join(NodeOS.homedir(), cwd.slice(2))
          : cwd;
    const directory = path.resolve(expanded);
    return fileSystem.makeDirectory(directory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new VcsProcessSpawnError({
            operation: "VcsProvisioningService.createDirectory",
            command: "mkdir",
            cwd: directory,
            cause,
          }),
      ),
      Effect.as(directory),
    );
  };

  const initRepository: VcsProvisioningService["Service"]["initRepository"] = Effect.fn(
    "VcsProvisioningService.initRepository",
  )(function* (input) {
    const kind = yield* resolveRequestedKind(input.kind);
    const driver = yield* registry.get(kind);
    const cwd = input.createDirectory ? yield* createDirectory(input.cwd) : input.cwd;
    return yield* driver.initRepository({ ...input, cwd });
  });

  return VcsProvisioningService.of({
    initRepository,
  });
});

export const layer = Layer.effect(VcsProvisioningService, make);
