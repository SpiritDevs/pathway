import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  createCliPublishInvocation,
  cliPublishOptionsIssue,
  publishedCliOverrides,
  publishedCliPlatforms,
} from "./cliPublish.ts";

const base = { access: "public", tag: "latest", provenance: false, dryRun: false, stage: true };

const packageJsonCodec = Schema.fromJsonString(Schema.Unknown);
const encodePackageJson = Schema.encodeEffect(packageJsonCodec);
const decodePackageJson = Schema.decodeUnknownEffect(packageJsonCodec);
const decodePackedArchive = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        files: Schema.Array(Schema.Struct({ path: Schema.String })),
      }),
    ),
  ),
);

describe("CLI release publication", () => {
  it("packs a reviewable local archive without any publication or stage command", () => {
    const invocation = createCliPublishInvocation({
      ...base,
      stage: false,
      pack: true,
      packDestination: "/tmp/pathway-review",
    });
    expect(invocation).toEqual({
      command: "vp",
      args: [
        "dlx",
        "npm@11.15.0",
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        "/tmp/pathway-review",
      ],
      cwd: "package",
    });
    expect(invocation.args).not.toContain("publish");
    expect(invocation.args).not.toContain("stage");
    expect(cliPublishOptionsIssue({ ...base, pack: true })).toContain("cannot be used together");
    expect(cliPublishOptionsIssue({ ...base, packDestination: "/tmp/pathway-review" })).toContain(
      "requires --pack",
    );
  });
  it("stages the prepared package from its own directory without a direct publish command", () => {
    expect(createCliPublishInvocation(base)).toEqual({
      command: "vp",
      args: ["dlx", "npm@11.15.0", "stage", "publish", "--access", "public", "--tag", "latest"],
      cwd: "package",
    });
  });

  it("keeps a staging dry run local instead of uploading a staged version", () => {
    const invocation = createCliPublishInvocation({ ...base, dryRun: true });
    expect(invocation.args).toEqual(["dlx", "npm@11.15.0", "pack", "--dry-run", "--json"]);
    expect(invocation.args).not.toContain("publish");
  });

  it("retains direct publication for an explicit first-package bootstrap", () => {
    const invocation = createCliPublishInvocation({ ...base, stage: false, provenance: true });
    expect(invocation.cwd).toBe("repository");
    expect(invocation.args).toContain("--provenance");
    expect(invocation.args).not.toContain("stage");
  });

  it.effect(
    "packs staging metadata with npm even when workspace overrides use pnpm selectors",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-cli-stage-" });
        for (const file of [
          "dist/bin.mjs",
          "dist/client/index.html",
          "dist/resource-monitor/darwin-arm64/pathway-resource-monitor",
        ]) {
          yield* fs.makeDirectory(path.dirname(path.join(directory, file)), { recursive: true });
          yield* fs.writeFileString(path.join(directory, file), "package fixture");
        }
        const packageJson = yield* encodePackageJson({
          name: "pathway-cli-stage-check",
          version: "0.0.0",
          files: ["dist"],
          ...publishedCliPlatforms(),
          ...publishedCliOverrides(true, { "dbus-next>usocket": "-" }),
        });
        yield* fs.writeFileString(path.join(directory, "package.json"), packageJson);
        const child = yield* spawner.spawn(
          ChildProcess.make("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
            cwd: directory,
          }),
        );
        const output = yield* child.stdout.pipe(Stream.decodeText, Stream.mkString);
        expect(yield* child.exitCode).toBe(0);
        const packed = yield* decodePackedArchive(output);
        expect(packed).toHaveLength(1);
        expect(packed[0]!.name).toBe("pathway-cli-stage-check");
        expect(packed[0]!.files.map((file) => file.path)).toEqual(
          expect.arrayContaining([
            "dist/bin.mjs",
            "dist/client/index.html",
            "dist/resource-monitor/darwin-arm64/pathway-resource-monitor",
          ]),
        );
        const metadata = yield* decodePackageJson(
          yield* fs.readFileString(path.join(directory, "package.json")),
        );
        expect(metadata).toMatchObject({ os: ["darwin"], cpu: ["arm64"] });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
