import * as DateTime from "effect/DateTime";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type Project,
  type OrchestrationV2ThreadProjection,
} from "@spiritdevs/contracts";
import { resolveSimBuildWorkspace } from "./SimBuildService.ts";
const input = {
  environmentId: EnvironmentId.make("env"),
  projectId: ProjectId.make("p"),
  threadId: ThreadId.make("t"),
};
const fixture = () => {
  const project = { id: input.projectId, workspaceRoot: "/project" } as Project;
  const projection = {
    thread: { projectId: input.projectId, worktreePath: "/worktree", deletedAt: null },
  } as OrchestrationV2ThreadProjection;
  return {
    project,
    projection,
    projects: { getById: vi.fn(() => Effect.succeed(Option.some(project))) },
    threads: { getThreadProjection: vi.fn(() => Effect.succeed(projection)) },
  };
};
it.effect(
  "uses the calling thread's worktree and falls back only to its registered project root",
  () =>
    Effect.gen(function* () {
      const h = fixture();
      expect(
        yield* resolveSimBuildWorkspace(input, input.environmentId, h.projects, h.threads),
      ).toBe("/worktree");
      h.threads.getThreadProjection.mockReturnValue(
        Effect.succeed({ ...h.projection, thread: { ...h.projection.thread, worktreePath: null } }),
      );
      expect(
        yield* resolveSimBuildWorkspace(input, input.environmentId, h.projects, h.threads),
      ).toBe("/project");
    }),
);
it.effect("rejects another environment before reading any project", () =>
  Effect.gen(function* () {
    const h = fixture();
    expect(
      yield* Effect.result(
        resolveSimBuildWorkspace(input, EnvironmentId.make("other"), h.projects, h.threads),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "invalid-project" } });
    expect(h.projects.getById).not.toHaveBeenCalled();
    expect(h.threads.getThreadProjection).not.toHaveBeenCalled();
  }),
);
it.effect("rejects a thread from another project, deleted threads, and rootless projects", () =>
  Effect.gen(function* () {
    const h = fixture();
    for (const thread of [
      { ...h.projection.thread, projectId: ProjectId.make("other") },
      { ...h.projection.thread, deletedAt: DateTime.makeUnsafe(0) },
    ]) {
      h.threads.getThreadProjection.mockReturnValue(Effect.succeed({ ...h.projection, thread }));
      expect(
        yield* Effect.result(
          resolveSimBuildWorkspace(input, input.environmentId, h.projects, h.threads),
        ),
      ).toMatchObject({ _tag: "Failure", failure: { code: "invalid-project" } });
    }
    h.threads.getThreadProjection.mockReturnValue(Effect.succeed(h.projection));
    h.projects.getById.mockReturnValue(
      Effect.succeed(Option.some({ ...h.project, workspaceRoot: null })),
    );
    expect(
      yield* Effect.result(
        resolveSimBuildWorkspace(input, input.environmentId, h.projects, h.threads),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "invalid-project" } });
  }),
);
