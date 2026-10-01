import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import { SimBuildHost } from "./SimBuildHost.ts";
import { runSimBuildProcess } from "./SimBuildProcess.ts";
import type { EnvironmentId } from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { SimBuildError, type SimBuildContext } from "@spiritdevs/contracts/simBuild";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { DeviceService } from "../device/DeviceService.ts";
import { SimBuildRuntime } from "./SimBuildRuntime.ts";
import { fileSimBuildStore } from "./SimBuildStore.ts";

const run = async <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> => {
  const result = await Effect.runPromise(Effect.result(effect), signal ? { signal } : undefined);
  if (result._tag === "Failure") throw result.failure;
  return result.success;
};

export class SimBuildService extends Context.Service<SimBuildService, SimBuildRuntime>()(
  "@spiritdevs/pathway/simBuild/SimBuildService",
) {}

export const resolveSimBuildWorkspace = Effect.fn("SimBuild.resolve")(function* (
  input: SimBuildContext,
  environmentId: EnvironmentId,
  projects: Pick<ProjectService["Service"], "getById">,
  threads: Pick<ThreadManagementService["Service"], "getThreadProjection">,
) {
  if (input.environmentId !== environmentId)
    return yield* new SimBuildError({
      code: "invalid-project",
      message: "This project belongs to a different environment connection.",
    });
  const project = yield* projects.getById(input.projectId);
  const projection = yield* threads.getThreadProjection(input.threadId);
  if (
    Option.isNone(project) ||
    project.value.workspaceRoot === null ||
    projection.thread.projectId !== input.projectId ||
    projection.thread.deletedAt !== null
  )
    return yield* new SimBuildError({
      code: "invalid-project",
      message: "Choose a thread in a project with a directory on this environment.",
    });
  return projection.thread.worktreePath ?? project.value.workspaceRoot;
});

export const layer = Layer.effect(
  SimBuildService,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const platform = yield* HostProcessPlatform;
    const path = yield* Path.Path;
    const projects = yield* ProjectService;
    const threads = yield* ThreadManagementService;
    const devices = yield* DeviceService;
    const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;

    const root = path.join(config.stateDir, "sim-build");
    const runtime = new SimBuildRuntime(
      root,
      {
        resolve: (input, signal) =>
          run(resolveSimBuildWorkspace(input, environmentId, projects, threads), signal),
        destination: (input, signal) =>
          run(
            Effect.gen(function* () {
              const state = yield* devices.list;
              const device = state.devices.find(
                (device) => device.hostId === input.hostId && device.id === input.deviceId,
              );
              if (state.hostStatus === "disabled" || !device)
                return yield* new SimBuildError({
                  code: "invalid-destination",
                  message:
                    "Enable device support and choose a simulator from this environment's Device panel.",
                });
              return device;
            }),
            signal,
          ),
        claim: (input, signal) =>
          run(
            devices.claimDevice(input.hostId, input.deviceId).pipe(
              Effect.mapError(
                () =>
                  new SimBuildError({
                    code: "invalid-destination",
                    message: "This simulator is owned by another environment or is unavailable.",
                  }),
              ),
            ),
            signal,
          ),
      },
      fileSimBuildStore(path.join(root, "receipts.json")),
      new SimBuildHost(runSimBuildProcess, platform),
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()));
    return runtime;
  }),
);
