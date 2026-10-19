// @effect-diagnostics nodeBuiltinImport:off -- the standalone entry reads its driver and capability file and generates its capability with Node primitives.
/**
 * Standalone Cua driver host: runs the same {@link makeCuaDriverHost} the
 * macOS desktop embeds, outside Electron, against a provisioned `cua-driver`.
 * This is the Windows/Linux deployment path: the Pathway server reaches the
 * socket this host listens on through `PATHWAY_CUA_HOST_SOCKET` and
 * authenticates every request with the shared capability
 * (`PATHWAY_CUA_HOST_CAPABILITY`).
 *
 *   node apps/desktop/src/computer/CuaDriverHostStandalone.ts \
 *     --driver /opt/pathway/cua-driver [--socket /run/pathway-cua/host.sock]
 *
 * This is not a port of the macOS safety layer. `nativeRevision: null` permits
 * upstream artifacts, whose transport cancellation cannot acknowledge native
 * input drain. This host has no global Escape adapter, so Linux browser
 * mutations stay closed; browser observation and passive endpoint detection
 * remain available. There is no pathway-helper, masked-activation shield,
 * frame tap or permission setup path; `check_permissions` uses the driver's
 * own platform report.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";

import { makeCuaDriverHost, sweepOrphanedCuaDrivers } from "./CuaDriverHost.ts";
import { clearStaleCuaHostSocket } from "./CuaHostSocket.ts";

class StandaloneUsageError extends Schema.TaggedErrorClass<StandaloneUsageError>()(
  "StandaloneUsageError",
  { message: Schema.String },
) {}

const USAGE =
  "usage: cua-driver-host --driver <binary-or-bundle-dir> " +
  "[--socket <unix-path|\\\\.\\pipe\\name>] [--capability-file <path>]";

// oxlint-disable-next-line pathway/no-global-process-runtime -- a CLI entry reads its own argv and environment.
const { argv, env } = process;

function option(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const usage = (message: string) => new StandaloneUsageError({ message: `${message}\n${USAGE}` });

const program = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const driverOption = option("--driver") ?? env.PATHWAY_CUA_DRIVER;
  if (!driverOption)
    return yield* usage("--driver is required (provisioned cua-driver binary or bundle dir).");

  const isDirectory = yield* Effect.promise(() =>
    NodeFSP.stat(driverOption).then(
      (stats) => stats.isDirectory(),
      () => false,
    ),
  );
  const binaryPath = isDirectory
    ? NodePath.join(driverOption, platform === "win32" ? "cua-driver.exe" : "cua-driver")
    : driverOption;
  yield* Effect.tryPromise({
    try: () => NodeFSP.access(binaryPath),
    catch: () => usage(`driver not found or not readable: ${binaryPath}`),
  });

  // The capability is the authority boundary on this socket: it must never
  // travel through argv, which every process on the machine can read.
  const capabilityFile = option("--capability-file");
  let capability = env.PATHWAY_CUA_HOST_CAPABILITY?.trim() ?? "";
  let capabilitySource = "environment";
  if (!capability && capabilityFile) {
    capability = (yield* Effect.promise(() =>
      NodeFSP.readFile(capabilityFile, "utf8").catch(() => ""),
    )).trim();
    capabilitySource = capabilityFile;
  }
  if (!capability) {
    capability = NodeCrypto.randomBytes(32).toString("base64url");
    if (capabilityFile) {
      yield* Effect.tryPromise({
        try: () => NodeFSP.writeFile(capabilityFile, `${capability}\n`, { mode: 0o600 }),
        catch: () => usage(`could not write the capability file ${capabilityFile}`),
      });
      capabilitySource = capabilityFile;
    } else {
      capabilitySource = "generated-below";
    }
  }
  if (Buffer.byteLength(capability, "utf8") < 32)
    return yield* usage(
      "capability must be at least 32 bytes (PATHWAY_CUA_HOST_CAPABILITY or --capability-file).",
    );

  const endpoint = option("--socket");
  if (endpoint) yield* clearStaleCuaHostSocket(endpoint);

  yield* sweepOrphanedCuaDrivers();
  const host = yield* makeCuaDriverHost({
    binaryPath,
    // TCC's bundle identity has no meaning off macOS; the string still labels
    // this host in permission replies that surface it.
    bundleId: `pathway-cua-standalone-${platform}`,
    capability,
    nativeRevision: null,
    ...(platform === "linux"
      ? {
          inputMonitorState: Effect.succeed({
            ready: false,
            error: "linux_global_escape_unavailable",
          }),
        }
      : {}),
    ...(endpoint ? { hostEndpoint: endpoint } : {}),
    setup: Effect.fail({
      message:
        `This host cannot request ${platform} permissions. Grant the driver host ` +
        "whatever display-server or automation access the platform requires, then retry.",
    }),
  });
  const bound = yield* host.listen;

  // Everything the operator needs to wire the server, on stdout. The
  // capability value itself only prints when it was generated with nowhere
  // to store it: a bootstrap path, not a logging channel.
  yield* Console.log(`CUA_HOST_ENDPOINT=${bound}`);
  if (capabilitySource === "generated-below") {
    yield* Console.log(`CUA_CAPABILITY=${capability}`);
    yield* Console.log(
      "[cua-driver-host] generated an ephemeral capability (above). Set it on the server as " +
        "PATHWAY_CUA_HOST_CAPABILITY; it dies with this host.",
    );
  } else {
    yield* Console.log(`[cua-driver-host] capability source: ${capabilitySource}`);
  }
  yield* Console.log(
    `[cua-driver-host] server wiring: PATHWAY_CUA_HOST_SOCKET=${bound} PATHWAY_CUA_HOST_CAPABILITY=<capability>`,
  );
  yield* Console.log(
    `[cua-driver-host] driver: ${NodePath.basename(binaryPath)} (capabilities checked at handshake)`,
  );
  if (platform === "linux")
    yield* Console.log(
      "[cua-driver-host] no global Escape adapter: Linux browser observation is available; browser actions are disabled.",
    );
  // Serve until SIGINT/SIGTERM interrupts the main fiber; closing the scope
  // disposes the host and retires its driver.
  return yield* Effect.never.pipe(
    Effect.onInterrupt(() =>
      host.dispose.pipe(
        Effect.catch((error) =>
          Console.error(`[cua-driver-host] cleanup failed: ${error.message}`),
        ),
      ),
    ),
  );
});

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
