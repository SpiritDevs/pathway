import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionProjects from "../persistence/Services/ProjectionProjects.ts";
import { layerFromProjectRepository, RuntimePolicyV2 } from "./RuntimePolicy.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const TestLayer = layerFromProjectRepository.pipe(
  Layer.provide(
    Layer.mock(ProjectionProjects.ProjectionProjectRepository)({
      getById: () =>
        Effect.succeed(
          Option.some({
            projectId,
            title: "Project",
            workspaceRoot: "/project-root",
            internalWorkspaceRoot: "/internal-project",
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            scripts: [],
            createdAt: "2026-06-21T00:00:00.000Z",
            updatedAt: "2026-06-21T00:00:00.000Z",
            deletedAt: null,
          }),
        ),
    }),
  ),
);

it.layer(TestLayer)("RuntimePolicyV2", (it) => {
  it.effect("uses the project root for local-checkout threads", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: null }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-root");
      assert.deepEqual(resolved.additionalDirectories, ["/internal-project"]);
    }),
  );

  it.effect("prefers a provisioned worktree over the project root", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: "/project-worktree" }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-worktree");
    }),
  );

  it.effect("runs a projectless conversation in its environment-owned folder", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: {
          ...makeThread({ now, worktreePath: null }),
          projectId: null,
          conversationPath: "/isolated/userdata/conversations/thread",
        },
        modelSelection,
      });
      assert.equal(resolved.cwd, "/isolated/userdata/conversations/thread");
    }),
  );

  it.effect("preserves access to the conversation folder after project attachment", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: {
          ...makeThread({ now, worktreePath: "/project-worktree" }),
          conversationPath: "/isolated/userdata/conversations/thread",
        },
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-worktree");
      assert.deepEqual(resolved.additionalDirectories, [
        "/isolated/userdata/conversations/thread",
        "/internal-project",
      ]);
    }),
  );

  it.effect("refuses a projectless thread without a working folder", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicyV2;
      const now = yield* DateTime.now;
      const error = yield* policy
        .resolve({
          thread: { ...makeThread({ now, worktreePath: null }), projectId: null },
          modelSelection,
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "RuntimePolicyResolveError");
    }),
  );
});
