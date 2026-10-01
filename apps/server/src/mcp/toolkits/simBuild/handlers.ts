import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import {
  SimBuildError,
  type SimBuildAction,
  type SimBuildOptions,
} from "@spiritdevs/contracts/simBuild";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { SimBuildService } from "../../../simBuild/SimBuildService.ts";
import { safeSimBuildError } from "../../../simBuild/SimBuildRuntime.ts";
import { SimBuildToolkit } from "./tools.ts";

const context = Effect.gen(function* () {
  const invocation = yield* McpInvocationContext;
  const settings = yield* (yield* ServerSettingsService).getSettings.pipe(
    Effect.mapError(safeSimBuildError),
  );
  if (
    !invocation.capabilities.has("device") ||
    !settings.enableDeviceSupport ||
    !settings.enableAgentDeviceAccess ||
    !invocation.projectId
  )
    return yield* new SimBuildError({
      code: "unavailable",
      message: "Enable agent device access and use a thread in this environment's project.",
    });
  const runtime = yield* SimBuildService;
  return {
    runtime,
    invocation,
    input: {
      environmentId: invocation.environmentId,
      projectId: invocation.projectId,
      threadId: invocation.threadId,
    },
  };
});
const start = Effect.fn("simBuild.mcp.start")(function* (
  action: SimBuildAction,
  options: SimBuildOptions & { readonly requestId?: string | undefined },
) {
  const { runtime, invocation, input } = yield* context;
  const requestId =
    options.requestId ??
    invocation.requestIdempotencyKey ??
    (yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie));
  return yield* Effect.tryPromise({
    try: () => runtime.start({ ...input, ...options, action, requestId }),
    catch: safeSimBuildError,
  });
});
export const simBuildToolHandlers = {
  device_build_discover: () =>
    Effect.gen(function* () {
      const { runtime, input } = yield* context;
      return yield* Effect.tryPromise({
        try: (signal) => runtime.discover(input, signal),
        catch: safeSimBuildError,
      });
    }),
  device_build: (input) => start("build", input),
  device_run: (input) => start("run", input),
  device_test: (input) => start("test", input),
  device_build_status: (job) =>
    Effect.gen(function* () {
      const { runtime, input } = yield* context;
      return yield* Effect.tryPromise({
        try: () => runtime.get({ ...input, ...job }),
        catch: safeSimBuildError,
      });
    }),
  device_build_wait: (job) =>
    Effect.gen(function* () {
      const { runtime, input } = yield* context;
      return yield* Effect.tryPromise({
        try: () => runtime.drain({ ...input, ...job }),
        catch: safeSimBuildError,
      });
    }),
  device_build_cancel: (job) =>
    Effect.gen(function* () {
      const { runtime, input } = yield* context;
      return yield* Effect.tryPromise({
        try: () => runtime.cancel({ ...input, ...job }),
        catch: safeSimBuildError,
      });
    }),
} satisfies Parameters<typeof SimBuildToolkit.toLayer>[0];
export const SimBuildToolkitHandlersLive = SimBuildToolkit.toLayer(simBuildToolHandlers);
