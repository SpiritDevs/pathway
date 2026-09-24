import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ComputerDispatchAccess } from "../orchestration-v2/ComputerDispatchAccess.ts";
import {
  ThreadLaunchService,
  type ThreadLaunchInput,
  type ThreadLaunchResult,
} from "../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import {
  ProviderAllowanceRuntime,
  AllowanceInheritanceError,
} from "../providerUsage/AllowanceRuntime.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ScheduledTaskService, layer } from "./ScheduledTaskService.ts";

it.effect(
  "retains a scheduled origin through edits and binds each fresh worker before launch",
  () =>
    Effect.gen(function* () {
      const parent = ThreadId.make("thread:allowance-parent");
      const environment = EnvironmentId.make("studio");
      const bindings = new Set<string>();
      const launched: ThreadLaunchInput[] = [];
      const clearances: Array<string> = [];
      let available = true;
      const dependencies = Layer.mergeAll(
        SqlitePersistenceMemory,
        NodeServices.layer,
        Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(environment) }),
        Layer.mock(ProviderAllowanceRuntime)({
          inheritThread: (source, destination, child) =>
            Effect.gen(function* () {
              assert.equal(source, parent);
              assert.equal(destination, environment);
              if (!available)
                return yield* new AllowanceInheritanceError({
                  message: "Cloud unavailable",
                  cause: null,
                });
              bindings.add(child);
            }),
        }),
        Layer.mock(ThreadManagementService)({}),
        Layer.mock(ThreadLaunchService)({
          launch: (input) =>
            Effect.gen(function* () {
              assert.isTrue(bindings.has(input.threadId!));
              launched.push(input);
              clearances.push(yield* (yield* ComputerDispatchAccess).clearance.pipe(Effect.orDie));
              return { threadId: input.threadId! } as ThreadLaunchResult;
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService;
        const input = {
          title: "Nightly review",
          prompt: "Review current work",
          enabled: true,
          projectId: ProjectId.make("project"),
          allowanceParentThreadId: parent,
          schedule: { type: "interval" as const, everyMs: 60_000 },
          workspaceStrategy: { type: "root" as const },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
        };
        const { task } = yield* service.upsert(input);
        const { allowanceParentThreadId: _parent, ...edit } = input;
        yield* service.upsert({ ...edit, id: task.id, title: "Edited review" });
        const { tasks: listed } = yield* service.list();
        assert.equal(listed[0]?.allowanceParentThreadId, parent);
        yield* service.runNow({ id: task.id });
        assert.equal(launched.length, 1);
        // The schedule sends as the server, so a scheduled `/computer-use` is admitted.
        assert.deepEqual(clearances, ["admins-only"]);
        available = false;
        yield* service.runNow({ id: task.id }).pipe(Effect.result);
        assert.equal(launched.length, 1);
        const failed = (yield* service.list()).tasks[0];
        assert.equal(failed?.lastRunStatus, "failed");
        assert.include(failed?.lastRunError ?? "", "Cloud unavailable");
      }).pipe(Effect.provide(layer.pipe(Layer.provide(dependencies))));
    }),
);
