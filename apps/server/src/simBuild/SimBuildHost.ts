// @effect-diagnostics nodeBuiltinImport:off -- Project discovery and Xcode process adapter.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  SimBuildError,
  type SimBuildContainer,
  type SimBuildDiscovery,
  type SimBuildOptions,
  type SimBuildArtifact,
} from "@spiritdevs/contracts/simBuild";
import { type SimBuildProcess, type SimBuildOutput } from "./SimBuildProcess.ts";

const List = Schema.Struct({
  project: Schema.optional(
    Schema.Struct({
      schemes: Schema.optional(Schema.Array(Schema.String)),
      targets: Schema.optional(Schema.Array(Schema.String)),
      configurations: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  workspace: Schema.optional(
    Schema.Struct({ schemes: Schema.optional(Schema.Array(Schema.String)) }),
  ),
});
const Package = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const Settings = Schema.Array(
  Schema.Struct({
    target: Schema.String,
    buildSettings: Schema.Record(Schema.String, Schema.String),
  }),
);
const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  text: string,
): S["Type"] => {
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(schema))(text);
  } catch {
    throw new SimBuildError({
      code: "process-failed",
      message: "Xcode returned an invalid JSON response.",
    });
  }
};
const within = (root: string, path: string) => {
  const relative = NodePath.relative(root, path);
  return (
    relative === "" ||
    (!relative.startsWith(`..${NodePath.sep}`) &&
      relative !== ".." &&
      !NodePath.isAbsolute(relative))
  );
};
const skipped = new Set(["node_modules", "Pods", "build", "DerivedData", "vendor"]);

export class SimBuildHost {
  readonly run: SimBuildProcess;
  readonly platform: NodeJS.Platform;
  constructor(run: SimBuildProcess, platform: NodeJS.Platform) {
    this.run = run;
    this.platform = platform;
  }
  async developerDir(signal: AbortSignal) {
    if (this.platform !== "darwin")
      throw new SimBuildError({
        code: "needs-mac",
        message: "Simulator builds require this project's environment to run on a Mac.",
      });
    // COR-101 selects with xcode-select. Ignore ambient DEVELOPER_DIR and pin this path for the whole job.
    const dir = (
      await this.run(
        {
          file: "/usr/bin/xcode-select",
          args: ["-p"],
          env: { DEVELOPER_DIR: undefined },
          capture: true,
        },
        signal,
      )
    ).trim();
    if (!dir.endsWith("/Contents/Developer"))
      throw new SimBuildError({
        code: "unavailable",
        message: "Select a full Xcode installation in Xcode setup first.",
      });
    return dir;
  }
  async discover(
    root: string,
    developerDir: string,
    signal: AbortSignal,
    output?: SimBuildOutput,
  ): Promise<Pick<SimBuildDiscovery, "framework" | "containers" | "notices">> {
    const realRoot = await NodeFSP.realpath(root);
    let framework: SimBuildDiscovery["framework"] = "xcode";
    try {
      const pkg = decode(
        Package,
        await NodeFSP.readFile(NodePath.join(root, "package.json"), "utf8"),
      );
      const deps = { ...pkg.devDependencies, ...pkg.dependencies };
      framework = deps.expo ? "expo" : deps["react-native"] ? "react-native" : "xcode";
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const candidates: string[] = [];
    let visited = 0;
    const visit = async (directory: string, depth: number): Promise<void> => {
      signal.throwIfAborted();
      if (++visited > 2000 || candidates.length >= 64)
        throw new SimBuildError({
          code: "invalid-project",
          message: "Too many project directories to discover. Attach a narrower project directory.",
        });
      for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || skipped.has(entry.name)) continue;
        const path = NodePath.join(directory, entry.name);
        if (/\.(xcodeproj|xcworkspace)$/.test(entry.name)) {
          if (candidates.length >= 64)
            throw new SimBuildError({
              code: "invalid-project",
              message: "Too many Xcode containers. Attach a narrower project directory.",
            });
          candidates.push(path);
          continue;
        }
        if (depth < 3) await visit(path, depth + 1);
      }
    };
    await visit(realRoot, 0);
    const containers: SimBuildContainer[] = [];
    for (const path of candidates.sort()) {
      const kind = path.endsWith(".xcworkspace") ? "workspace" : "project";
      const listed = decode(
        List,
        await this.run(
          {
            file: `${developerDir}/usr/bin/xcodebuild`,
            args: [kind === "workspace" ? "-workspace" : "-project", path, "-list", "-json"],
            cwd: realRoot,
            env: { DEVELOPER_DIR: developerDir },
            capture: true,
          },
          signal,
          output
            ? async (text, source) => {
                if (source === "stderr") await output(text, source);
              }
            : undefined,
        ),
      );
      const info = listed.project ?? listed.workspace;
      if (!info)
        throw new SimBuildError({
          code: "process-failed",
          message: "Xcode returned no project or workspace listing.",
        });
      containers.push({
        path: NodePath.relative(realRoot, path),
        kind,
        schemes: info.schemes ?? [],
        targets: listed.project?.targets ?? [],
        configurations: listed.project?.configurations ?? [],
      });
    }
    return {
      framework,
      containers,
      notices:
        containers.length === 0
          ? [
              framework === "expo"
                ? "Generate the native ios/ project with Expo prebuild before running on a simulator."
                : "No Xcode project or workspace was found within three directory levels.",
            ]
          : framework === "xcode"
            ? []
            : [
                "Uses the generated ios/ project. Install CocoaPods dependencies first. Release builds bundle JavaScript; Debug builds require your project's Metro server.",
              ],
    };
  }
  async resolveContainer(root: string, relative: string) {
    const realRoot = await NodeFSP.realpath(root);
    const candidate = await NodeFSP.realpath(NodePath.resolve(root, relative));
    if (
      NodePath.isAbsolute(relative) ||
      !within(realRoot, candidate) ||
      !/\.(xcodeproj|xcworkspace)$/.test(candidate)
    )
      throw new SimBuildError({
        code: "invalid-project",
        message: "Choose a discovered project or workspace inside the thread's checkout.",
      });
    return candidate;
  }
  args(container: string, input: SimBuildOptions, derivedData: string, configuration: string) {
    return [
      container.endsWith(".xcworkspace") ? "-workspace" : "-project",
      container,
      "-scheme",
      input.scheme,
      "-configuration",
      configuration,
      "-destination",
      `platform=iOS Simulator,id=${input.deviceId}`,
      "-derivedDataPath",
      derivedData,
      "CODE_SIGNING_ALLOWED=NO",
    ];
  }
  async artifact(
    root: string,
    developerDir: string,
    args: string[],
    input: SimBuildOptions,
    derivedData: string,
    signal: AbortSignal,
    output: SimBuildOutput,
  ): Promise<typeof SimBuildArtifact.Type> {
    const rows = decode(
      Settings,
      await this.run(
        {
          file: `${developerDir}/usr/bin/xcodebuild`,
          args: [...args, "-showBuildSettings", "-json"],
          cwd: root,
          env: { DEVELOPER_DIR: developerDir },
          capture: true,
        },
        signal,
        async (text, source) => {
          if (source === "stderr") await output(text, source);
        },
      ),
    );
    const apps = rows.filter(
      ({ target, buildSettings: b }) =>
        b.WRAPPER_EXTENSION === "app" &&
        b.PLATFORM_NAME === "iphonesimulator" &&
        (!input.target || target === input.target),
    );
    if (apps.length !== 1)
      throw new SimBuildError({
        code: "invalid-project",
        message:
          "Select one application target produced by this scheme. Extensions and test runners cannot be launched.",
      });
    const { target, buildSettings: b } = apps[0]!;
    if (!b.TARGET_BUILD_DIR || !b.FULL_PRODUCT_NAME || !b.PRODUCT_BUNDLE_IDENTIFIER)
      throw new SimBuildError({
        code: "invalid-project",
        message: "Xcode did not resolve the app bundle path and bundle identifier.",
      });
    const appPath = await NodeFSP.realpath(NodePath.join(b.TARGET_BUILD_DIR, b.FULL_PRODUCT_NAME));
    if (!within(await NodeFSP.realpath(derivedData), appPath))
      throw new SimBuildError({
        code: "invalid-project",
        message: "The app output is outside this job's DerivedData directory.",
      });
    return { target, appPath, bundleId: b.PRODUCT_BUNDLE_IDENTIFIER };
  }
}
