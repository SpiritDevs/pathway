/**
 * The `projects` MCP toolkit — handler half.
 *
 * Local settings go through `ProjectService.update`, the same path Project Settings uses. A company
 * project's icon lives in Pathway Cloud, so it is written there through the environment identity;
 * a project outside any company keeps the older icon file inside its own directory.
 *
 * @module projects/handlers
 */
import { CommandId, type Project, type ProjectId } from "@spiritdevs/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { CloudSyncEngineRegistry } from "../../../cloud/CloudSyncEngineRegistry.ts";
import { CloudProjectIcons } from "../../../cloud/cloudProjectIcons.ts";
import { ProjectService, type ProjectUpdateInput } from "../../../project/ProjectService.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ProjectsMcpError, type ProjectsMcpProject, ProjectsToolkit } from "./tools.ts";

/** Matches the cloud limit, checked here so an oversized file is refused before it is read. */
const ICON_IMAGE_MAX_BYTES = 1024 * 1024;

const ICON_MIME_BY_EXTENSION: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

const fail = (message: string) => Effect.fail(new ProjectsMcpError({ message }));
const asToolError = Effect.mapError(
  (error: { readonly message: string }) => new ProjectsMcpError({ message: error.message }),
);

const format = (project: Project, currentId: ProjectId | undefined): ProjectsMcpProject => ({
  name: project.title,
  workspaceRoot: project.workspaceRoot,
  current: project.id === currentId,
  iconFile: project.faviconPath ?? null,
  defaultModelSelection: project.defaultModelSelection,
  defaultThreadEnvMode: project.defaultThreadEnvMode ?? null,
  scripts: project.scripts,
});

/** Built per call: services come from the MCP runtime context, like the other toolkits. */
const make = Effect.gen(function* () {
  const projects = yield* ProjectService;
  const icons = yield* CloudProjectIcons;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const registry = Option.getOrNull(yield* Effect.serviceOption(CloudSyncEngineRegistry));

  const commandId = crypto.randomUUIDv4.pipe(
    Effect.orDie,
    Effect.map((uuid) => CommandId.make(`command:mcp:project-update:${uuid}`)),
  );

  /** Resolves a name or workspace path; omitted means the calling thread's project. */
  const resolve = Effect.fn("projects.mcp.resolve")(function* (reference: string | undefined) {
    const invocation = yield* McpInvocationContext;
    const all = (yield* projects.snapshot.pipe(asToolError)).projects;
    const wanted = reference?.trim() ?? "";
    if (wanted.length === 0) {
      const own = all.find((project) => project.id === invocation.projectId);
      if (own === undefined) {
        return yield* fail("This thread has no project. Name one with the project field.");
      }
      return own;
    }
    const byRoot = all.filter(
      (project) =>
        project.workspaceRoot !== null &&
        path.resolve(project.workspaceRoot) === path.resolve(wanted),
    );
    const matches =
      byRoot.length > 0
        ? byRoot
        : all.filter((project) => project.title.toLowerCase() === wanted.toLowerCase());
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      const roots = matches.map((project) => project.workspaceRoot ?? "(no directory)");
      return yield* fail(
        `Several projects are named "${wanted}". Pass a workspace path instead: ${roots.join(", ")}.`,
      );
    }
    const names = all.map((project) => project.title);
    return yield* fail(
      `No project named "${wanted}". Projects: ${names.length === 0 ? "none" : names.join(", ")}.`,
    );
  });

  const update = (project: Project, patch: Omit<ProjectUpdateInput, "commandId" | "projectId">) =>
    commandId.pipe(
      Effect.flatMap((id) => projects.update({ ...patch, commandId: id, projectId: project.id })),
      asToolError,
    );

  const respond = (project: Project) =>
    McpInvocationContext.pipe(
      Effect.map((invocation) => ({ project: format(project, invocation.projectId) })),
    );

  /** The company project this checkout is bound to, or null for a project outside any company. */
  const companyTarget = Effect.fn("projects.mcp.companyTarget")(function* (project: Project) {
    if (registry === null) return null;
    const invocation = yield* McpInvocationContext;
    const route = yield* registry.issueEngineForProject({
      environmentId: invocation.environmentId,
      localProjectId: project.id,
    });
    switch (route._tag) {
      case "Legacy":
      case "Unbound":
        return null;
      case "Unavailable":
        return yield* fail("Pathway Cloud is still syncing this company. Retry shortly.");
      case "Ambiguous":
        return yield* fail("This project is bound to more than one company; refusing to guess.");
      case "Ready": {
        const binding = route.projectBindings.find((b) => b.localProjectId === project.id);
        return binding === undefined
          ? null
          : { companyId: route.engine.companyId, cloudProjectId: binding.cloudProjectId };
      }
    }
  });

  const readIconImage = Effect.fn("projects.mcp.readIconImage")(function* (absolutePath: string) {
    const mimeType = ICON_MIME_BY_EXTENSION[path.extname(absolutePath).toLowerCase()];
    if (mimeType === undefined) {
      return yield* fail("The icon must be an avif, gif, ico, jpeg, png, svg, or webp image.");
    }
    const info = yield* fileSystem
      .stat(absolutePath)
      .pipe(
        Effect.mapError(() => new ProjectsMcpError({ message: `No file at ${absolutePath}.` })),
      );
    if (info.type !== "File") return yield* fail(`${absolutePath} is not a file.`);
    if (Number(info.size) > ICON_IMAGE_MAX_BYTES) {
      return yield* fail("A project icon must be an image of at most 1 MB.");
    }
    const bytes = yield* fileSystem.readFile(absolutePath).pipe(asToolError);
    return { bytes, mimeType };
  });

  return {
    projects,
    icons,
    workspacePaths,
    path,
    resolve,
    update,
    respond,
    companyTarget,
    readIconImage,
  };
});

export const ProjectsToolkitHandlersLive = ProjectsToolkit.toLayer({
  projects_list: () =>
    Effect.gen(function* () {
      const { projects } = yield* make;
      const invocation = yield* McpInvocationContext;
      const snapshot = yield* projects.snapshot.pipe(asToolError);
      return {
        projects: snapshot.projects.map((project) => format(project, invocation.projectId)),
      };
    }),

  projects_update: ({ project: reference, name, ...settings }) =>
    Effect.gen(function* () {
      const { resolve, update, respond } = yield* make;
      const project = yield* resolve(reference);
      const patch = { ...settings, ...(name === undefined ? {} : { title: name }) };
      if (Object.keys(patch).length === 0) return yield* respond(project);
      return yield* respond(yield* update(project, patch));
    }),

  projects_set_icon: ({ project: reference, icon }) =>
    Effect.gen(function* () {
      const {
        icons,
        workspacePaths,
        path,
        resolve,
        update,
        respond,
        companyTarget,
        readIconImage,
      } = yield* make;
      const project = yield* resolve(reference);
      const company = yield* companyTarget(project);
      const clearIconFile = (current: Project) =>
        current.faviconPath == null
          ? Effect.succeed(current)
          : update(current, { faviconPath: null });

      if (icon._tag === "automatic") {
        if (company !== null) yield* icons.setIcon({ ...company, icon: null }).pipe(asToolError);
        return yield* respond(yield* clearIconFile(project));
      }

      const root = project.workspaceRoot;
      if (!path.isAbsolute(icon.path) && root === null) {
        return yield* fail("This project has no directory. Pass an absolute image path.");
      }
      const absolutePath = path.isAbsolute(icon.path) ? icon.path : path.join(root!, icon.path);
      const image = yield* readIconImage(absolutePath);

      if (company !== null) {
        yield* icons.setImage({ ...company, ...image }).pipe(asToolError);
        return yield* respond(yield* clearIconFile(project));
      }

      // Outside a company the icon is a file the project's own checkout serves.
      if (root === null) {
        return yield* fail("This project has no directory to keep an icon file in.");
      }
      const inside = yield* workspacePaths
        .resolveRelativePathWithinRoot({
          workspaceRoot: root,
          relativePath: path.relative(root, absolutePath),
        })
        .pipe(
          Effect.mapError(
            () =>
              new ProjectsMcpError({
                message: `This project is not in a company, so its icon must be a file inside ${root}. Copy the image there first.`,
              }),
          ),
        );
      return yield* respond(yield* update(project, { faviconPath: inside.relativePath }));
    }),
});
