import { describe, expect, it } from "vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import {
  createCliPublishInvocation,
  cliPublishOptionsIssue,
  publishedCliOverrides,
  publishedCliPlatforms,
} from "./cliPublish.ts";

const base = { access: "public", tag: "latest", provenance: false, dryRun: false, stage: true };

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

  it("packs staging metadata with npm even when workspace overrides use pnpm selectors", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pathway-cli-stage-"));
    try {
      for (const file of [
        "dist/bin.mjs",
        "dist/client/index.html",
        "dist/resource-monitor/darwin-arm64/pathway-resource-monitor",
      ]) {
        NodeFS.mkdirSync(NodePath.dirname(NodePath.join(directory, file)), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(directory, file), "package fixture");
      }
      NodeFS.writeFileSync(
        NodePath.join(directory, "package.json"),
        JSON.stringify({
          name: "pathway-cli-stage-check",
          version: "0.0.0",
          files: ["dist"],
          ...publishedCliPlatforms(),
          ...publishedCliOverrides(true, { "dbus-next>usocket": "-" }),
        }),
      );
      const output = NodeChildProcess.execFileSync(
        "npm",
        ["pack", "--dry-run", "--json", "--ignore-scripts"],
        {
          cwd: directory,
          encoding: "utf8",
        },
      );
      const packed = JSON.parse(output)[0];
      expect(packed.name).toBe("pathway-cli-stage-check");
      expect(packed.files.map((file: { path: string }) => file.path)).toEqual(
        expect.arrayContaining([
          "dist/bin.mjs",
          "dist/client/index.html",
          "dist/resource-monitor/darwin-arm64/pathway-resource-monitor",
        ]),
      );
      expect(
        JSON.parse(NodeFS.readFileSync(NodePath.join(directory, "package.json"), "utf8")),
      ).toMatchObject({ os: ["darwin"], cpu: ["arm64"] });
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
