import { type OrchestrationV2AppThread, type ProjectId } from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { randomUuidV4 } from "./RandomUuid.ts";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";

export class ThreadProjectAttachmentError extends Schema.TaggedErrorClass<ThreadProjectAttachmentError>()("ThreadProjectAttachmentError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Resolves a local project and creates the dedicated workspace required by a temporary thread. */
export class ThreadProjectAttachment extends Context.Service<ThreadProjectAttachment, {
  readonly prepare: (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly projectId: ProjectId;
    readonly baseRef?: string;
  }) => Effect.Effect<{ readonly branch: string | null; readonly worktreePath: string | null }, ThreadProjectAttachmentError>;
}>()("@spiritdevs/pathway/orchestration-v2/ThreadProjectAttachment") {}

export const layer = Layer.effect(ThreadProjectAttachment, Effect.gen(function* () {
  const projects = yield* ProjectionProjectRepository;
  const git = yield* Effect.serviceOption(GitWorkflowService);
  return ThreadProjectAttachment.of({
    prepare: Effect.fn("ThreadProjectAttachment.prepare")(function* (input) {
      const project = yield* projects.getById({ projectId: input.projectId }).pipe(
        Effect.mapError((cause) => new ThreadProjectAttachmentError({ message: "Could not load the selected project.", cause })),
      );
      if (Option.isNone(project) || project.value.workspaceRoot === null) {
        return yield* new ThreadProjectAttachmentError({ message: "Choose a project with a workspace on this environment." });
      }
      const cwd = project.value.workspaceRoot;
      if (input.thread.temporary !== true) return { branch: null, worktreePath: null };
      if (Option.isNone(git)) return yield* new ThreadProjectAttachmentError({ message: "Git worktree support is unavailable on this environment." });
      const result = yield* git.value.createWorktree({
        cwd,
        refName: input.baseRef ?? "HEAD",
        newRefName: `conversation-${(yield* randomUuidV4).slice(0, 12)}`,
        path: null,
      }).pipe(Effect.mapError((cause) => new ThreadProjectAttachmentError({
        message: "Could not create the temporary thread's worktree. The conversation has not been attached.", cause,
      })));
      return { branch: result.worktree.refName, worktreePath: result.worktree.path };
    }),
  });
}));
