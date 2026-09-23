/**
 * Builds the ComputerService: picks the backend for this host, runs the passive
 * boot probe, and owns the manager for the layer's lifetime.
 *
 * Requires `ComputerApprovalGate`, so Off/Stop withdraws approval cards and a
 * desktop interruption revokes standing grants.
 *
 * @module computer/Layers/ComputerService
 */
import type { ComputerAvailability } from "@spiritdevs/contracts";
import { CUA_HOST_SOCKET_ENV } from "@spiritdevs/shared/cuaDriverProtocol";
import { HostProcessEnvironment, HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../../config.ts";
import type { ComputerBackend } from "../ComputerBackend.ts";
import { ComputerApprovalGate } from "../ComputerApprovalGate.ts";
import { ComputerManager } from "../ComputerManager.ts";
import { makeCuaComputerBackend } from "../CuaComputerBackend.ts";
import { FakeComputerBackend } from "../FakeComputerBackend.ts";
import { ComputerService, type ComputerServiceShape } from "../Services/ComputerService.ts";
import {
  makeUnavailableComputerBackend,
  UnavailableComputerBackend,
} from "../UnavailableComputerBackend.ts";

export const COMPUTER_BACKEND_ENV = "PATHWAY_COMPUTER_BACKEND";
export const COMPUTER_HOST_CAPABILITY_ENV = "PATHWAY_BROWSER_HOST_CAPABILITY";
export const COMPUTER_HOST_CAPABILITY_FD_ENV = "PATHWAY_BROWSER_HOST_CAPABILITY_FD";

export interface ComputerServiceLiveOptions {
  /** Inject a real or fake backend. */
  readonly backend?: ComputerBackend;
  /** Test/embedding override for the final availability decision. */
  readonly supported?: boolean;
}

const MIN_CAPABILITY_BYTES = 32;

/**
 * The host socket's shared secret: given directly, or inherited on a file
 * descriptor the desktop app opened for this server. Anything shorter than
 * the minimum is ignored rather than trusted.
 */
const resolveHostCapability = Effect.fn("resolveHostCapability")(function* (
  env: NodeJS.ProcessEnv,
) {
  const usable = (value: string | undefined) =>
    value !== undefined && Buffer.byteLength(value, "utf8") >= MIN_CAPABILITY_BYTES
      ? value
      : undefined;
  const direct = usable(env[COMPUTER_HOST_CAPABILITY_ENV]?.trim());
  if (direct) return direct;
  const rawFd = env[COMPUTER_HOST_CAPABILITY_FD_ENV]?.trim();
  if (!rawFd || !/^\d+$/.test(rawFd)) return undefined;
  const fd = Number(rawFd);
  if (fd < 3 || fd > 255) return undefined;
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(`/dev/fd/${fd}`).pipe(
    Effect.map((value) => usable(value.trim())),
    Effect.orElseSucceed(() => undefined),
  );
});

export const makeComputerServiceLayer = (options: ComputerServiceLiveOptions = {}) =>
  Layer.effect(
    ComputerService,
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const env = yield* HostProcessEnvironment;
      const requestedBackend = env[COMPUTER_BACKEND_ENV]?.trim().toLowerCase();
      // macOS runs the bundled host the desktop app provisions; elsewhere the
      // same backend is routable when a host endpoint is configured explicitly.
      // No endpoint means no backend: the gate is reachability, never platform
      // optimism.
      const hostEndpoint = env[CUA_HOST_SOCKET_ENV]?.trim() || undefined;
      const backend: ComputerBackend =
        options.backend ??
        (requestedBackend === "fake" ? new FakeComputerBackend() : undefined) ??
        (platform === "darwin" || hostEndpoint
          ? yield* makeCuaComputerBackend({
              endpoint: hostEndpoint,
              capability: yield* resolveHostCapability(env),
            })
          : yield* makeUnavailableComputerBackend(
              `No computer backend is configured for this server running on ${platform}.`,
              {
                availability:
                  platform === "linux"
                    ? {
                        kind: "backend-unavailable",
                        message: "No computer backend is available on this server.",
                      }
                    : { kind: "unsupported-platform", platform },
              },
            ));
      const config = yield* Effect.serviceOption(ServerConfig);
      if (Option.isNone(config)) {
        yield* Effect.logWarning("computer state dir unavailable; using in-memory control state");
      }
      const manager = yield* ComputerManager.make({
        backend,
        approvals: yield* ComputerApprovalGate,
        ...(Option.isSome(config) ? { stateDir: config.value.stateDir } : {}),
      });
      let availability: ComputerAvailability;
      if (options.supported === undefined) {
        // The passive probe, never the establishing read. Boot runs for every
        // user of every build, long before anyone has asked for a desktop.
        availability = yield* backend.probeAvailability().pipe(
          Effect.catch((error) =>
            Effect.succeed<ComputerAvailability>({
              kind: "backend-unavailable",
              message: error.message,
            }),
          ),
        );
      } else if (options.supported) {
        availability = { kind: "available", backend: "test-override" };
      } else {
        availability = {
          kind: "backend-unavailable",
          message: "Computer support is disabled by the service configuration.",
        };
      }
      return {
        // Supported backends stay routable before setup grants access.
        supported: options.supported ?? !(backend instanceof UnavailableComputerBackend),
        availability,
        manager,
      } satisfies ComputerServiceShape;
    }),
  );

export const ComputerServiceLive = makeComputerServiceLayer();
