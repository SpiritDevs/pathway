import * as NodeCrypto from "node:crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import {
  type CommandId,
  ModelSelection,
  type ProjectFaviconPath,
  ProjectId,
  type Project,
  type ProjectScript,
  type ProjectSnapshot,
  type ThreadEnvMode,
} from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionProjects from "../persistence/Services/ProjectionProjects.ts";
import { ProjectEnrichmentService, type ProjectEnrichment } from "./ProjectEnrichmentService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export interface ProjectCreateInput {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string | null;
  readonly createWorkspaceRootIfMissing?: boolean;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly scripts?: ReadonlyArray<ProjectScript>;
}

export interface ProjectUpdateInput {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title?: string;
  readonly titleIsCustom?: boolean;
  readonly workspaceRoot?: string;
  readonly createWorkspaceRootIfMissing?: boolean;
  readonly useInternalWorkspace?: boolean;
  readonly copyInternalWorkspaceFiles?: boolean;
  readonly disconnectInternalWorkspace?: boolean;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly defaultThreadEnvMode?: ThreadEnvMode | null;
  readonly faviconPath?: ProjectFaviconPath | null;
  readonly scripts?: ReadonlyArray<ProjectScript>;
}

export interface ProjectBootstrapInput extends Omit<ProjectCreateInput, "workspaceRoot"> {
  readonly workspaceRoot: string;
}

export interface ProjectDeleteInput {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
}

export class ProjectNotFoundError extends Schema.TaggedErrorClass<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} was not found.`;
  }
}

export class ProjectConflictError extends Schema.TaggedErrorClass<ProjectConflictError>()(
  "ProjectConflictError",
  {
    projectId: ProjectId,
    workspaceRoot: Schema.String,
    conflictingProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Workspace ${this.workspaceRoot} already belongs to project ${this.conflictingProjectId}.`;
  }
}

export class ProjectOperationError extends Schema.TaggedErrorClass<ProjectOperationError>()(
  "ProjectOperationError",
  {
    operation: Schema.Literals([
      "normalize-workspace",
      "manage-workspace",
      "read-project",
      "list-projects",
      "dispatch-project-command",
    ]),
    projectId: Schema.optional(ProjectId),
    workspaceRoot: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    if (this.operation === "manage-workspace" && this.cause instanceof Error)
      return this.cause.message;
    return `Project operation '${this.operation}' failed${this.projectId === undefined ? "" : ` for ${this.projectId}`}.`;
  }
}

export type ProjectServiceError =
  | ProjectNotFoundError
  | ProjectConflictError
  | ProjectOperationError;

export class ProjectService extends Context.Service<
  ProjectService,
  {
    readonly create: (input: ProjectCreateInput) => Effect.Effect<Project, ProjectServiceError>;
    readonly bootstrap: (
      input: ProjectBootstrapInput,
    ) => Effect.Effect<
      { readonly project: Project; readonly created: boolean },
      ProjectServiceError
    >;
    readonly update: (input: ProjectUpdateInput) => Effect.Effect<Project, ProjectServiceError>;
    readonly delete: (input: ProjectDeleteInput) => Effect.Effect<Project, ProjectServiceError>;
    readonly getById: (
      projectId: ProjectId,
      options?: { readonly includeDeleted?: boolean },
    ) => Effect.Effect<Option.Option<Project>, ProjectOperationError>;
    readonly getByWorkspaceRoot: (
      workspaceRoot: string,
      options?: { readonly includeDeleted?: boolean },
    ) => Effect.Effect<Option.Option<Project>, ProjectOperationError>;
    readonly snapshot: Effect.Effect<ProjectSnapshot, ProjectOperationError>;
  }
>()("@spiritdevs/pathway/project/ProjectService") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const internalRoot = (projectId: ProjectId) =>
    path.join(
      config.stateDir,
      "project-workspaces",
      NodeCrypto.createHash("sha256").update(projectId).digest("hex"),
    );
  const workspaceError = (projectId: ProjectId) => (cause: unknown) =>
    new ProjectOperationError({ operation: "manage-workspace", projectId, cause });
  const refuseWorkspaceChange = (projectId: ProjectId, message: string) =>
    Effect.fail(workspaceError(projectId)(new Error(message)));
  const assertWorkspaceIdle = Effect.fn("ProjectService.assertWorkspaceIdle")(function* (
    projectId: ProjectId,
  ) {
    const active = yield* sql`
      SELECT 1 FROM orchestration_v2_projection_runs r
      JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
      WHERE t.project_id = ${projectId} AND t.deleted_at IS NULL
        AND r.status IN ('preparing', 'queued', 'starting', 'running', 'waiting') LIMIT 1
    `.pipe(Effect.mapError(workspaceError(projectId)));
    if (active.length > 0)
      return yield* refuseWorkspaceChange(
        projectId,
        "Finish or stop active agent work before changing project directories.",
      );
  });
  const copyWorkingFiles = Effect.fn("ProjectService.copyWorkingFiles")(function* (
    projectId: ProjectId,
    source: string,
    destination: string,
  ) {
    if (
      source === destination ||
      destination.startsWith(source + path.sep) ||
      source.startsWith(destination + path.sep)
    ) {
      return yield* refuseWorkspaceChange(
        projectId,
        "Choose a directory outside the internal workspace.",
      );
    }
    const entries = yield* fs
      .readDirectory(source)
      .pipe(Effect.mapError(workspaceError(projectId)));
    // Preflight all top-level names before copying anything. Sources are always retained.
    for (const entry of entries) {
      if (
        yield* fs
          .exists(path.join(destination, entry))
          .pipe(Effect.mapError(workspaceError(projectId)))
      ) {
        return yield* refuseWorkspaceChange(
          projectId,
          `The destination already contains ${entry}. Keep files internally or choose an empty directory.`,
        );
      }
    }
    for (const entry of entries) {
      yield* fs
        .copy(path.join(source, entry), path.join(destination, entry), { overwrite: false })
        .pipe(Effect.mapError(workspaceError(projectId)));
    }
  });
  const projects = yield* ProjectionProjects.ProjectionProjectRepository;
  const projectEnrichment = yield* ProjectEnrichmentService;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

  const toProject = (
    row: ProjectionProjects.ProjectionProject,
    enrichment: ProjectEnrichment | null,
  ): Project => ({
    id: row.projectId,
    title: row.title,
    titleIsCustom: row.titleIsCustom === 1,
    workspaceRoot: row.workspaceRoot,
    internalWorkspaceRoot: row.internalWorkspaceRoot ?? null,
    repositoryIdentity: enrichment?.repositoryIdentity ?? null,
    faviconPath: row.faviconPath ?? enrichment?.faviconPath ?? null,
    defaultModelSelection: row.defaultModelSelection,
    defaultThreadEnvMode: row.defaultThreadEnvMode,
    scripts: row.scripts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  });

  const hydrateAvailable = Effect.fn("ProjectService.hydrateAvailable")(function* (
    row: ProjectionProjects.ProjectionProject,
  ) {
    const enrichment =
      row.workspaceRoot === null
        ? null
        : row.deletedAt === null
          ? yield* projectEnrichment.getAvailable(row.workspaceRoot)
          : yield* projectEnrichment.peek(row.workspaceRoot);
    return toProject(row, enrichment);
  });

  const readRows = Effect.fn("ProjectService.readRows")(function* () {
    return yield* projects
      .listAll()
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "list-projects", cause }),
        ),
      );
  });

  const getById: ProjectService["Service"]["getById"] = Effect.fn("ProjectService.getById")(
    function* (projectId, options) {
      const row = yield* projects
        .getById({ projectId })
        .pipe(
          Effect.mapError(
            (cause) => new ProjectOperationError({ operation: "read-project", projectId, cause }),
          ),
        );
      if (Option.isNone(row) || (row.value.deletedAt !== null && !options?.includeDeleted)) {
        return Option.none();
      }
      return Option.some(yield* hydrateAvailable(row.value));
    },
  );

  const getByWorkspaceRoot: ProjectService["Service"]["getByWorkspaceRoot"] = Effect.fn(
    "ProjectService.getByWorkspaceRoot",
  )(function* (workspaceRoot, options) {
    const normalized = yield* workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectOperationError({
            operation: "normalize-workspace",
            workspaceRoot,
            cause,
          }),
      ),
    );
    const row = (yield* readRows()).find(
      (candidate) =>
        candidate.workspaceRoot === normalized &&
        (options?.includeDeleted === true || candidate.deletedAt === null),
    );
    return row === undefined ? Option.none() : Option.some(yield* hydrateAvailable(row));
  });

  const readCommitted = Effect.fn("ProjectService.readCommitted")(function* (projectId: ProjectId) {
    const row = yield* projects
      .getById({ projectId })
      .pipe(
        Effect.mapError(
          (cause) => new ProjectOperationError({ operation: "read-project", projectId, cause }),
        ),
      );
    if (Option.isNone(row)) {
      return yield* new ProjectOperationError({
        operation: "read-project",
        projectId,
        cause: "The accepted project command did not produce a project projection.",
      });
    }
    return yield* hydrateAvailable(row.value);
  });

  const invalidateEnrichment = (...workspaceRoots: ReadonlyArray<string | null>) =>
    projectEnrichment.invalidate(workspaceRoots.filter((root): root is string => root !== null));

  const dispatch = <A>(
    projectId: ProjectId,
    command: Parameters<OrchestrationEngineService["Service"]["dispatch"]>[0],
    onCommitted: Effect.Effect<A, ProjectOperationError>,
  ) =>
    engine.dispatch(command).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectOperationError({
            operation: "dispatch-project-command",
            projectId,
            cause,
          }),
      ),
      Effect.andThen(onCommitted),
    );

  const assertWorkspaceAvailable = Effect.fn("ProjectService.assertWorkspaceAvailable")(function* (
    projectId: ProjectId,
    workspaceRoot: string,
  ) {
    const conflicting = (yield* readRows()).find(
      (candidate) =>
        candidate.deletedAt === null &&
        candidate.projectId !== projectId &&
        candidate.workspaceRoot === workspaceRoot,
    );
    if (conflicting !== undefined) {
      return yield* new ProjectConflictError({
        projectId,
        workspaceRoot,
        conflictingProjectId: conflicting.projectId,
      });
    }
  });

  const create: ProjectService["Service"]["create"] = Effect.fn("ProjectService.create")(
    function* (input) {
      const workspaceRoot = yield* workspacePaths
        .normalizeWorkspaceRoot(input.workspaceRoot ?? internalRoot(input.projectId), {
          createIfMissing:
            input.workspaceRoot === null || (input.createWorkspaceRootIfMissing ?? false),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProjectOperationError({
                operation: "normalize-workspace",
                projectId: input.projectId,
                workspaceRoot: input.workspaceRoot ?? internalRoot(input.projectId),
                cause,
              }),
          ),
        );
      if (workspaceRoot !== null) {
        yield* assertWorkspaceAvailable(input.projectId, workspaceRoot);
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      return yield* dispatch(
        input.projectId,
        {
          type: "project.create",
          commandId: input.commandId,
          projectId: input.projectId,
          title: input.title,
          workspaceRoot,
          internalWorkspaceRoot: input.workspaceRoot === null ? workspaceRoot : null,
          defaultModelSelection: input.defaultModelSelection ?? null,
          scripts: [...(input.scripts ?? [])],
          createdAt: now,
        },
        invalidateEnrichment(workspaceRoot).pipe(Effect.andThen(readCommitted(input.projectId))),
      );
    },
  );

  const update: ProjectService["Service"]["update"] = Effect.fn("ProjectService.update")(
    function* (input) {
      const existing = yield* projects.getById({ projectId: input.projectId }).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectOperationError({
              operation: "read-project",
              projectId: input.projectId,
              cause,
            }),
        ),
      );
      if (Option.isNone(existing) || existing.value.deletedAt !== null) {
        return yield* new ProjectNotFoundError({ projectId: input.projectId });
      }
      if (
        input.useInternalWorkspace &&
        (input.workspaceRoot !== undefined ||
          input.disconnectInternalWorkspace ||
          input.copyInternalWorkspaceFiles)
      ) {
        return yield* refuseWorkspaceChange(
          input.projectId,
          "Choose one workspace operation at a time.",
        );
      }
      if (
        input.copyInternalWorkspaceFiles &&
        (input.workspaceRoot === undefined || existing.value.internalWorkspaceRoot == null)
      ) {
        return yield* refuseWorkspaceChange(
          input.projectId,
          "Attach a directory to copy internal workspace files.",
        );
      }
      if (
        input.workspaceRoot !== undefined ||
        input.useInternalWorkspace ||
        input.disconnectInternalWorkspace
      ) {
        yield* assertWorkspaceIdle(input.projectId);
      }
      if (input.useInternalWorkspace && existing.value.workspaceRoot !== null) {
        return yield* refuseWorkspaceChange(
          input.projectId,
          "This project already has a workspace.",
        );
      }
      if (
        input.disconnectInternalWorkspace &&
        (existing.value.internalWorkspaceRoot == null ||
          existing.value.workspaceRoot === existing.value.internalWorkspaceRoot)
      ) {
        return yield* refuseWorkspaceChange(
          input.projectId,
          "Attach your own directory before disconnecting the internal workspace.",
        );
      }
      const requestedRoot = input.useInternalWorkspace
        ? internalRoot(input.projectId)
        : input.workspaceRoot;
      const workspaceRoot =
        requestedRoot === undefined
          ? undefined
          : yield* workspacePaths
              .normalizeWorkspaceRoot(requestedRoot, {
                createIfMissing:
                  input.useInternalWorkspace || input.createWorkspaceRootIfMissing || false,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ProjectOperationError({
                      operation: "normalize-workspace",
                      projectId: input.projectId,
                      workspaceRoot: input.workspaceRoot,
                      cause,
                    }),
                ),
              );
      if (workspaceRoot !== undefined) {
        yield* assertWorkspaceAvailable(input.projectId, workspaceRoot);
        if (input.copyInternalWorkspaceFiles && existing.value.internalWorkspaceRoot != null) {
          yield* copyWorkingFiles(
            input.projectId,
            existing.value.internalWorkspaceRoot,
            workspaceRoot,
          );
        }
      }
      return yield* dispatch(
        input.projectId,
        {
          type: "project.meta.update",
          ...(input.useInternalWorkspace
            ? { internalWorkspaceRoot: workspaceRoot! }
            : input.disconnectInternalWorkspace
              ? { internalWorkspaceRoot: null }
              : {}),
          commandId: input.commandId,
          projectId: input.projectId,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.titleIsCustom !== undefined
            ? { titleIsCustom: input.titleIsCustom }
            : input.title !== undefined
              ? { titleIsCustom: true }
              : {}),
          ...(workspaceRoot === undefined || workspaceRoot === existing.value.workspaceRoot
            ? {}
            : { workspaceRoot }),
          ...(input.defaultModelSelection === undefined
            ? {}
            : { defaultModelSelection: input.defaultModelSelection }),
          ...(input.defaultThreadEnvMode === undefined
            ? {}
            : { defaultThreadEnvMode: input.defaultThreadEnvMode }),
          ...(input.faviconPath === undefined ? {} : { faviconPath: input.faviconPath }),
          ...(input.scripts === undefined ? {} : { scripts: [...input.scripts] }),
        },
        (workspaceRoot === undefined || workspaceRoot === existing.value.workspaceRoot
          ? Effect.void
          : invalidateEnrichment(existing.value.workspaceRoot, workspaceRoot)
        ).pipe(Effect.andThen(readCommitted(input.projectId))),
      );
    },
  );

  const bootstrap: ProjectService["Service"]["bootstrap"] = Effect.fn("ProjectService.bootstrap")(
    function* (input) {
      const existing = yield* getByWorkspaceRoot(input.workspaceRoot);
      if (Option.isSome(existing)) return { project: existing.value, created: false };
      return { project: yield* create(input), created: true };
    },
  );

  const deleteProject: ProjectService["Service"]["delete"] = Effect.fn("ProjectService.delete")(
    function* (input) {
      const { projectId } = input;
      const existing = yield* projects
        .getById({ projectId })
        .pipe(
          Effect.mapError(
            (cause) => new ProjectOperationError({ operation: "read-project", projectId, cause }),
          ),
        );
      if (Option.isNone(existing) || existing.value.deletedAt !== null) {
        return yield* new ProjectNotFoundError({ projectId });
      }
      return yield* dispatch(
        projectId,
        {
          type: "project.delete",
          commandId: input.commandId,
          projectId,
        },
        invalidateEnrichment(existing.value.workspaceRoot).pipe(
          Effect.andThen(readCommitted(projectId)),
        ),
      );
    },
  );

  const snapshot = Effect.gen(function* () {
    const rows = (yield* readRows()).filter((row) => row.deletedAt === null);
    const hydrated = yield* Effect.forEach(rows, hydrateAvailable, { concurrency: 8 });
    return {
      projects: hydrated,
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    } satisfies ProjectSnapshot;
  });

  return ProjectService.of({
    create,
    bootstrap,
    update,
    delete: deleteProject,
    getById,
    getByWorkspaceRoot,
    snapshot,
  });
});

export const layer = Layer.effect(ProjectService, make);
