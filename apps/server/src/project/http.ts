import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type ProjectMutation,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import {
  ProjectService,
  type ProjectServiceError,
  type ProjectUpdateInput,
} from "./ProjectService.ts";

type ProjectUpdateMutation = Extract<ProjectMutation, { readonly type: "project.update" }>;

export function httpProjectUpdateInputFromMutation(
  mutation: ProjectUpdateMutation,
): ProjectUpdateInput {
  return {
    commandId: mutation.commandId,
    projectId: mutation.projectId,
    ...(mutation.title === undefined ? {} : { title: mutation.title }),
    ...(mutation.workspaceRoot === undefined ? {} : { workspaceRoot: mutation.workspaceRoot }),
    ...(mutation.defaultModelSelection === undefined
      ? {}
      : { defaultModelSelection: mutation.defaultModelSelection }),
    ...(mutation.defaultThreadEnvMode === undefined
      ? {}
      : { defaultThreadEnvMode: mutation.defaultThreadEnvMode }),
    ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
  };
}

export const failProjectMutation = Effect.fn("environment.projects.failMutation")(function* (
  cause: ProjectServiceError | ServerRuntimeStartup.ServerRuntimeStartupError,
) {
  if (cause._tag === "ProjectNotFoundError" || cause._tag === "ProjectConflictError") {
    return yield* failEnvironmentInvalidRequest("invalid_command");
  }
  return yield* failEnvironmentInternal("project_mutation_failed", cause);
});

export const projectHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "projects",
  Effect.fnUntraced(function* (handlers) {
    const projects = yield* ProjectService;
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.projects.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projects.snapshot.pipe(
            Effect.catch((cause) => failEnvironmentInternal("project_snapshot_failed", cause)),
          );
        }),
      )
      .handle(
        "mutate",
        Effect.fn("environment.projects.mutate")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const mutation = args.payload;
          const operation =
            mutation.type === "project.create"
              ? projects.create({
                  commandId: mutation.commandId,
                  projectId: mutation.projectId,
                  title: mutation.title,
                  workspaceRoot: mutation.workspaceRoot,
                  ...(mutation.defaultModelSelection === undefined
                    ? {}
                    : { defaultModelSelection: mutation.defaultModelSelection }),
                  ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
                })
              : mutation.type === "project.update"
                ? projects.update(httpProjectUpdateInputFromMutation(mutation))
                : projects.delete({
                    commandId: mutation.commandId,
                    projectId: mutation.projectId,
                  });
          return yield* startup.enqueueCommand(operation).pipe(Effect.catch(failProjectMutation));
        }),
      );
  }),
);
