import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@spiritdevs/contracts";
import { CloudProjectId } from "@spiritdevs/contracts/cloudProject";
import { CompanyId } from "@spiritdevs/contracts/company";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import {
  CloudSyncEngineRegistry,
  type CloudSyncEngineRegistryShape,
} from "../../../cloud/CloudSyncEngineRegistry.ts";
import { CloudProjectIcons } from "../../../cloud/cloudProjectIcons.ts";
import { ProjectService, type ProjectUpdateInput } from "../../../project/ProjectService.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectsToolkitHandlersLive } from "./handlers.ts";
import { ProjectsMcpError, type ProjectsMcpProject, ProjectsToolkit } from "./tools.ts";

const OWN = ProjectId.make("project-own");
const OTHER = ProjectId.make("project-other");
const COMPANY = CompanyId.make("company-1");
const CLOUD_PROJECT = CloudProjectId.make("cloud-project-1");

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  projectId: OWN,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex_personal"),
  providerDriverKind: ProviderDriverKind.make("codex"),
  capabilities: new Set(),
  issuedAt: 1,
};

const project = (id: ProjectId, title: string, workspaceRoot: string): Project => ({
  id,
  title,
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T00:00:00.000Z",
  deletedAt: null,
});

interface Harness {
  readonly root: string;
  readonly projects: Map<ProjectId, Project>;
  readonly iconCalls: Array<{
    readonly kind: string;
    readonly bytes?: number;
    readonly mime?: string;
  }>;
}

/** Runs `use` against two projects in a temp directory; `company` binds the own project to one. */
const withHarness = <A, E, R>(
  options: { readonly company: boolean },
  use: (harness: Harness) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(path.join(root, "own"));
    yield* fs.makeDirectory(path.join(root, "other"));
    const projects = new Map<ProjectId, Project>([
      [OWN, project(OWN, "Pathway", path.join(root, "own"))],
      [OTHER, project(OTHER, "Website", path.join(root, "other"))],
    ]);
    const iconCalls: Harness["iconCalls"] = [];

    const projectService = ProjectService.of({
      snapshot: Effect.sync(() => ({
        projects: [...projects.values()],
        updatedAt: "2026-09-28T00:00:00.000Z",
      })),
      update: ({ commandId: _commandId, projectId, ...patch }: ProjectUpdateInput) =>
        Effect.sync(() => {
          const current = projects.get(projectId)!;
          const next: Project = { ...current, ...patch };
          projects.set(projectId, next);
          return next;
        }),
    } as unknown as ProjectService["Service"]);
    const icons = CloudProjectIcons.of({
      setIcon: ({ icon }) =>
        Effect.sync(() => void iconCalls.push({ kind: icon === null ? "reset" : "library" })),
      setImage: ({ bytes, mimeType, companyId, cloudProjectId }) =>
        Effect.sync(() => {
          assert.strictEqual(companyId, COMPANY);
          assert.strictEqual(cloudProjectId, CLOUD_PROJECT);
          iconCalls.push({ kind: "image", bytes: bytes.byteLength, mime: mimeType });
        }),
    });
    const registry = {
      issueEngineForProject: ({ localProjectId }: { readonly localProjectId?: ProjectId }) =>
        Effect.succeed(
          options.company && localProjectId === OWN
            ? {
                _tag: "Ready",
                engine: { companyId: COMPANY },
                readModel: {},
                projectBindings: [{ localProjectId: OWN, cloudProjectId: CLOUD_PROJECT }],
              }
            : { _tag: "Unbound", companyIds: [COMPANY] },
        ),
    } as unknown as CloudSyncEngineRegistryShape;

    return yield* use({ root, projects, iconCalls }).pipe(
      Effect.provideService(ProjectService, projectService),
      Effect.provideService(CloudProjectIcons, icons),
      Effect.provideService(CloudSyncEngineRegistry, registry),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(ProjectsToolkitHandlersLive, WorkspacePaths.layer).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const callTool = (name: keyof typeof ProjectsToolkit.tools, params: unknown) =>
  Effect.gen(function* () {
    const built = yield* ProjectsToolkit;
    const handled = yield* built
      .handle(name, params as never)
      .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.map(Option.getOrThrow));
    if (handled.isFailure) return yield* handled.result as ProjectsMcpError;
    return (handled.result as { readonly project: ProjectsMcpProject }).project;
  });

const writeImage = (file: string, bytes: number) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.writeFile(file, new Uint8Array(bytes))));

it.effect("updates the calling thread's project when no project is named", () =>
  withHarness({ company: false }, ({ projects }) =>
    Effect.gen(function* () {
      const updated = yield* callTool("projects_update", {
        name: "Pathway App",
        defaultThreadEnvMode: "worktree",
      });
      assert.strictEqual(updated.name, "Pathway App");
      assert.strictEqual(updated.current, true);
      assert.strictEqual(updated.defaultThreadEnvMode, "worktree");
      assert.strictEqual(projects.get(OTHER)?.title, "Website");
    }),
  ),
);

it.effect("names a project case-insensitively and lists the options on a miss", () =>
  withHarness({ company: false }, ({ projects }) =>
    Effect.gen(function* () {
      yield* callTool("projects_update", { project: "website", defaultThreadEnvMode: null });
      assert.strictEqual(projects.get(OTHER)?.defaultThreadEnvMode, null);

      const missing = yield* callTool("projects_update", { project: "nope", name: "X" }).pipe(
        Effect.flip,
      );
      assert.include(missing.message, "Pathway, Website");
    }),
  ),
);

it.effect("uploads an icon image for a company project and drops the old icon file", () =>
  withHarness({ company: true }, ({ root, projects, iconCalls }) =>
    Effect.gen(function* () {
      projects.set(OWN, { ...projects.get(OWN)!, faviconPath: "old.png" });
      const image = `${root}/generated.png`;
      yield* writeImage(image, 64);

      const updated = yield* callTool("projects_set_icon", {
        icon: { _tag: "image", path: image },
      });
      assert.deepStrictEqual(iconCalls, [{ kind: "image", bytes: 64, mime: "image/png" }]);
      assert.strictEqual(updated.iconFile, null);

      yield* callTool("projects_set_icon", { icon: { _tag: "automatic" } });
      assert.deepStrictEqual(iconCalls.at(-1), { kind: "reset" });
    }),
  ),
);

it.effect("keeps an icon file inside the directory of a project outside any company", () =>
  withHarness({ company: false }, ({ root, iconCalls }) =>
    Effect.gen(function* () {
      yield* writeImage(`${root}/own/logo.svg`, 32);
      const updated = yield* callTool("projects_set_icon", {
        icon: { _tag: "image", path: "logo.svg" },
      });
      assert.strictEqual(updated.iconFile, "logo.svg");
      assert.deepStrictEqual(iconCalls, []);

      yield* writeImage(`${root}/elsewhere.png`, 32);
      const outside = yield* callTool("projects_set_icon", {
        icon: { _tag: "image", path: `${root}/elsewhere.png` },
      }).pipe(Effect.flip);
      assert.include(outside.message, "Copy the image there first");
    }),
  ),
);

it.effect("refuses files that are not small images before uploading", () =>
  withHarness({ company: true }, ({ root, iconCalls }) =>
    Effect.gen(function* () {
      yield* writeImage(`${root}/big.png`, 1024 * 1024 + 1);
      const big = yield* callTool("projects_set_icon", {
        icon: { _tag: "image", path: `${root}/big.png` },
      }).pipe(Effect.flip);
      assert.include(big.message, "at most 1 MB");

      const text = yield* callTool("projects_set_icon", {
        icon: { _tag: "image", path: `${root}/notes.txt` },
      }).pipe(Effect.flip);
      assert.include(text.message, "must be an avif");
      assert.deepStrictEqual(iconCalls, []);
    }),
  ),
);
