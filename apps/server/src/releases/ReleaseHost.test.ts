// @effect-diagnostics nodeBuiltinImport:off -- Real temporary files, mocked Xcode process boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { describe, expect, it } from "vite-plus/test";
import { CompanyId } from "@spiritdevs/contracts/company";
import { MacReleaseHost, releaseExportOptions, sha256File } from "./ReleaseHost.ts";
import { appleTestCredential } from "../../../../packages/backend/src/fixtures/appleTestKey.ts";
import type { XcodeCommand } from "../xcode/XcodeProcess.ts";
const target = {
  companyId: CompanyId.make("01990000-0000-7000-8000-000000000011"),
  accountId: "account",
  teamId: "APPLETEAM1",
  appId: "app",
};
describe("Xcode release boundary", () => {
  it("rejects an artifact changed after verification while keeping uploads file-backed", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "release-artifact-test-"));
    const artifactPath = NodePath.join(root, "App.ipa");
    try {
      await NodeFSP.writeFile(artifactPath, "first");
      const archive = {
        id: "archive",
        target,
        environmentId: "env",
        environmentLabel: "Mac",
        projectPath: "/App.xcodeproj",
        scheme: "App",
        bundleId: "com.example.app",
        version: "1.0",
        buildNumber: "1",
        platform: "IOS" as const,
        archivePath: "/archive",
        artifactPath,
        artifactSha256: await sha256File(artifactPath),
        artifactBytes: 5,
        createdAt: 1,
      };
      const host = new MacReleaseHost(root, "darwin");
      const source = await host.source(archive);
      expect(await source.slice(0, 5).text()).toBe("first");
      await NodeFSP.writeFile(artifactPath, "replacement");
      await expect(source.slice(0, 5).text()).rejects.toThrow();
      await expect(host.source(archive)).rejects.toMatchObject({ code: "artifact-changed" });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it.each(["success", "failed", "cancelled", "mismatch"])(
    "uses an ephemeral 0600 key and removes it after %s",
    async (scenario) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "release-host-test-"));
      const projectPath = NodePath.join(root, "Test.xcodeproj");
      await NodeFSP.mkdir(projectPath);
      const calls: XcodeCommand[] = [];
      let keyPath = "";
      const controller = new AbortController();
      const host = new MacReleaseHost(root, "darwin", async (command) => {
        calls.push(command);
        if (command.file.endsWith("security")) return "";
        if (command.file.endsWith("plutil"))
          return JSON.stringify({
            ApplicationProperties: {
              CFBundleIdentifier: "com.example.app",
              CFBundleShortVersionString: "1.0",
              CFBundleVersion: scenario === "mismatch" ? "1" : "12",
            },
          });
        keyPath = command.args[command.args.indexOf("-authenticationKeyPath") + 1]!;
        expect((await NodeFSP.stat(keyPath)).mode & 0o777).toBe(0o600);
        expect(await NodeFSP.readFile(keyPath, "utf8")).toBe(appleTestCredential.privateKey);
        expect(command.args.join(" ")).not.toContain(appleTestCredential.privateKey);
        if (scenario === "failed") throw new Error("upstream secret output");
        if (scenario === "cancelled") {
          controller.abort();
          throw new Error("aborted");
        }
        if (command.args.includes("-exportArchive")) {
          const exportPath = command.args[command.args.indexOf("-exportPath") + 1]!;
          await NodeFSP.mkdir(exportPath, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(exportPath, "App.ipa"), "artifact");
        }
        return "";
      });
      try {
        const input = {
          ...target,
          projectPath,
          scheme: "App",
          version: "1.0",
          platform: "IOS" as const,
        };
        const result = host.archive(
          input,
          "job",
          "12",
          "com.example.app",
          appleTestCredential,
          controller.signal,
          async () => {},
        );
        if (scenario === "success") {
          const archive = await result;
          expect(archive.artifactBytes).toBe(8);
          expect(archive.artifactSha256).toHaveLength(64);
          expect(calls.find((c) => c.args.includes("archive"))?.args).toContain(
            "CURRENT_PROJECT_VERSION=12",
          );
          expect(calls.find((c) => c.args.includes("archive"))?.args).toContain(
            "CODE_SIGN_IDENTITY=Apple Development",
          );
          expect(releaseExportOptions(target.teamId)).toContain(
            "<key>destination</key><string>export</string>",
          );
          expect(releaseExportOptions(target.teamId)).toContain(
            "<key>manageAppVersionAndBuildNumber</key><false/>",
          );
        } else
          await expect(result).rejects.toMatchObject({
            _tag: "ReleaseError",
            code:
              scenario === "cancelled"
                ? "cancelled"
                : scenario === "mismatch"
                  ? "artifact-changed"
                  : "archive-failed",
          });
        await expect(NodeFSP.stat(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await NodeFSP.readdir(NodePath.join(root, "keys"))).toEqual([]);
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
  it("refuses local distribution signing without modifying the keychain", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "release-signing-test-"));
    const projectPath = NodePath.join(root, "Test.xcodeproj");
    await NodeFSP.mkdir(projectPath);
    const calls: string[] = [];
    const host = new MacReleaseHost(root, "darwin", async (command) => {
      calls.push(command.file);
      return '1) "Apple Distribution: Test (APPLETEAM1)"';
    });
    try {
      await expect(
        host.archive(
          { ...target, projectPath, scheme: "App", version: "1.0", platform: "IOS" },
          "job",
          "1",
          "com.example.app",
          appleTestCredential,
          new AbortController().signal,
          async () => {},
        ),
      ).rejects.toMatchObject({ code: "signing-configuration" });
      expect(calls).toEqual(["/usr/bin/security"]);
      expect(await NodeFSP.readdir(NodePath.join(root, "keys"))).toEqual([]);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
