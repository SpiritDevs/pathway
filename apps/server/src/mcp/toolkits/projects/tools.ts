/**
 * The `projects` MCP toolkit — schema half.
 *
 * Lets an agent change what a person can change in Project Settings: the name, the icon, the
 * default model and workspace mode for new threads, and the project's scripts. Projects are named
 * the way a person names them; omitted, the calling thread's own project is used.
 *
 * @module projects/tools
 */
import { ModelSelection, ProjectScript, ThreadEnvMode } from "@spiritdevs/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { CloudProjectIcons } from "../../../cloud/cloudProjectIcons.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export class ProjectsMcpError extends Schema.TaggedErrorClass<ProjectsMcpError>()(
  "ProjectsMcpError",
  { message: Schema.String },
) {}

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectService,
  CloudProjectIcons,
  WorkspacePaths.WorkspacePaths,
  FileSystem.FileSystem,
  Path.Path,
  Crypto.Crypto,
];

const projectField = Schema.optionalKey(
  Schema.String.annotate({
    description:
      "Project to change, by name (case-insensitive) or workspace path. Omit to use the project this thread belongs to.",
  }),
);

export const ProjectsMcpProject = Schema.Struct({
  name: Schema.String,
  workspaceRoot: Schema.NullOr(Schema.String),
  /** True for the project the calling thread belongs to. */
  current: Schema.Boolean,
  /** Icon file inside the workspace, for projects outside any company. */
  iconFile: Schema.NullOr(Schema.String),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  defaultThreadEnvMode: Schema.NullOr(ThreadEnvMode),
  scripts: Schema.Array(ProjectScript),
});
export type ProjectsMcpProject = typeof ProjectsMcpProject.Type;

export const ProjectsMcpListResult = Schema.Struct({
  projects: Schema.Array(ProjectsMcpProject),
});

export const ProjectsMcpUpdateInput = Schema.Struct({
  project: projectField,
  name: Schema.optionalKey(
    Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty()).annotate({
      description: "New project name, shown in the sidebar and thread lists on every device.",
    }),
  ),
  defaultModelSelection: Schema.optionalKey(
    Schema.NullOr(ModelSelection).annotate({
      description:
        "Model new threads in this project start with. Pass null to fall back to the environment default. Copy ids from orchestrator_capabilities; do not invent them.",
    }),
  ),
  defaultThreadEnvMode: Schema.optionalKey(
    Schema.NullOr(ThreadEnvMode).annotate({
      description:
        "Where new threads work: the project directory or a fresh git worktree. Pass null to inherit pathway.json or the global setting.",
    }),
  ),
  scripts: Schema.optionalKey(
    Schema.Array(ProjectScript).annotate({
      description:
        "Replaces the whole script list. Read projects_list first and send the existing scripts back with your change, or they are removed.",
    }),
  ),
});

export const ProjectsMcpSetIconInput = Schema.Struct({
  project: projectField,
  icon: Schema.Union([
    Schema.TaggedStruct("image", {
      path: Schema.String.annotate({
        description:
          "Absolute path, or a path relative to the project directory, of an avif, gif, ico, jpeg, png, svg, or webp image of at most 1 MB. Projects outside a company can only use an image inside their own directory.",
      }),
    }),
    Schema.TaggedStruct("automatic", {}),
  ]).annotate({
    description:
      'Use "image" to show a picture as the project icon, or "automatic" to go back to the favicon detected from the project directory.',
  }),
});

export const ProjectsMcpProjectResult = Schema.Struct({ project: ProjectsMcpProject });

const projectTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, false).annotate(Tool.Destructive, false) as T;

export const ProjectsListTool = projectTool(
  Tool.make("projects_list", {
    description:
      "List the Pathway projects on this environment with the settings projects_update and projects_set_icon can change. Read-only.",
    success: ProjectsMcpListResult,
    failure: ProjectsMcpError,
    dependencies,
  }),
)
  .annotate(Tool.Title, "List projects")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const ProjectsUpdateTool = projectTool(
  Tool.make("projects_update", {
    description:
      "Change a project's settings: its name, the default model and workspace mode for new threads, and its scripts. Omitted fields are left alone. This changes the project for everyone who uses it, on every device.",
    parameters: ProjectsMcpUpdateInput,
    success: ProjectsMcpProjectResult,
    failure: ProjectsMcpError,
    dependencies,
  }),
)
  .annotate(Tool.Title, "Update project")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Idempotent, true);

export const ProjectsSetIconTool = projectTool(
  Tool.make("projects_set_icon", {
    description:
      "Set the picture shown for a project, or reset it to the detected favicon. For a company project the image is uploaded so every device shows it. This changes the project for everyone who uses it.",
    parameters: ProjectsMcpSetIconInput,
    success: ProjectsMcpProjectResult,
    failure: ProjectsMcpError,
    dependencies,
  }),
)
  .annotate(Tool.Title, "Set project icon")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Idempotent, true)
  // A company icon upload leaves this machine for Pathway Cloud.
  .annotate(Tool.OpenWorld, true);

export const ProjectsToolkit = Toolkit.make(
  ProjectsListTool,
  ProjectsUpdateTool,
  ProjectsSetIconTool,
);
