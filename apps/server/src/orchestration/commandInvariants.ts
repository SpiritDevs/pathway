import type { MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import type {
  OrchestrationCommand,
  OrchestrationMessage,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
} from "@t3tools/contracts/legacy-orchestration";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

export function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

/**
 * One active project per directory. Rootless projects hold no directory, so any
 * number of them coexist and none of them clashes with a rooted one: a null root
 * is an absence, not a value to compare.
 */
export function requireActiveProjectWorkspaceRootAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly workspaceRoot: string | null;
  readonly exceptProjectId?: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (input.workspaceRoot === null) {
    return Effect.void;
  }
  const normalizedWorkspaceRoot = normalizeProjectPathForComparison(input.workspaceRoot);
  const existingProject = input.readModel.projects.find(
    (project) =>
      project.deletedAt === null &&
      project.workspaceRoot !== null &&
      normalizeProjectPathForComparison(project.workspaceRoot) === normalizedWorkspaceRoot &&
      project.id !== input.exceptProjectId,
  );
  if (existingProject === undefined) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Active project '${existingProject.id}' already exists for workspace root '${normalizedWorkspaceRoot}'.`,
    ),
  );
}

/**
 * A thread runs commands in a directory, so it cannot belong to a rootless project.
 * Clients prompt for a directory and send `project.meta.update` first; reaching here
 * without one means that prompt was skipped.
 */
export function requireProjectWorkspaceRoot(input: {
  readonly command: OrchestrationCommand;
  readonly project: OrchestrationProject;
}): Effect.Effect<string, OrchestrationCommandInvariantError> {
  const workspaceRoot = input.project.workspaceRoot;
  if (workspaceRoot !== null) {
    return Effect.succeed(workspaceRoot);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.project.id}' has no workspace root, so command '${input.command.type}' cannot run. Attach a directory to it first.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireEditableLatestUserMessage(input: {
  readonly command: OrchestrationCommand;
  readonly thread: OrchestrationThread;
  readonly messageId: MessageId;
}): Effect.Effect<OrchestrationMessage, OrchestrationCommandInvariantError> {
  const latestUserMessage = input.thread.messages.findLast((message) => message.role === "user");
  if (!latestUserMessage || latestUserMessage.id !== input.messageId) {
    return Effect.fail(
      invariantError(
        input.command.type,
        "Only the latest user message can be edited and restarted.",
      ),
    );
  }

  if (input.thread.session?.status === "starting" || input.thread.session?.status === "running") {
    return Effect.fail(
      invariantError(
        input.command.type,
        "The current turn must stop before its message can be edited and restarted.",
      ),
    );
  }

  const messageCreatedAt = Date.parse(latestUserMessage.createdAt);
  const hasChangesSinceMessage = input.thread.checkpoints.some(
    (checkpoint) =>
      checkpoint.files.length > 0 &&
      (!Number.isFinite(messageCreatedAt) ||
        Date.parse(checkpoint.completedAt) >= messageCreatedAt),
  );
  if (hasChangesSinceMessage) {
    return Effect.fail(
      invariantError(
        input.command.type,
        "This message cannot be edited because its turn changed files.",
      ),
    );
  }

  return Effect.succeed(latestUserMessage);
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt !== null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is not archived for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt === null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findThreadById(input.readModel, input.threadId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireNonNegativeInteger(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}
