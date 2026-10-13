import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderSessionId, ThreadId } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../../provider/Layers/ProviderEventLoggers.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import {
  ClaudeAgentSdkQueryRunner,
  claudeAgentSdkQueryRunnerLiveLayer,
} from "./ClaudeAdapterV2.ts";

const sdk = vi.hoisted(() => ({ query: vi.fn(() => ({ close: vi.fn() })) }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query, forkSession: vi.fn() }));

const testLayer = claudeAgentSdkQueryRunnerLiveLayer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
);

describe("Claude SDK workspace validation", () => {
  for (const scenario of ["missing", "file", "directory", "default"] as const) {
    it.effect(`validates the ${scenario} workspace before spawning Claude`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          sdk.query.mockClear();
          const runner = yield* ClaudeAgentSdkQueryRunner;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const directory = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "pathway-claude-workspace-",
          });
          const cwd = scenario === "directory" ? directory : path.join(directory, scenario);
          if (scenario === "file") yield* fileSystem.writeFileString(cwd, "not a directory");

          const result = yield* Effect.result(
            runner.open({
              threadId: ThreadId.make("thread-claude-workspace"),
              providerSessionId: ProviderSessionId.make("session-claude-workspace"),
              options: {
                model: "claude-sonnet-4-6",
                tools: [],
                permissionMode: "default",
                sessionId: "native-claude-workspace",
                pathToClaudeCodeExecutable: "claude",
                ...(scenario === "default" ? {} : { cwd }),
              },
            }),
          );

          if (result._tag === "Failure") {
            assert.isTrue(scenario === "missing" || scenario === "file");
            assert.equal(result.failure.method, "workspace");
            const failure = makeProviderFailure({
              cause: result.failure,
              class: "transport_error",
            });
            assert.include(failure.message, cwd);
            assert.include(
              failure.message,
              scenario === "missing" ? "Restore the worktree" : "not a directory",
            );
            assert.notInclude(failure.message, "binary not found");
            assert.equal(sdk.query.mock.calls.length, 0);
          } else {
            assert.isTrue(scenario === "directory" || scenario === "default");
            assert.equal(sdk.query.mock.calls.length, 1);
            yield* result.success.close;
          }
        }).pipe(Effect.provide(testLayer)),
      ),
    );
  }
});
