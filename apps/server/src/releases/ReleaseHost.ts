// @effect-diagnostics nodeBuiltinImport:off -- Injectable host boundary; never logs Xcode output or credentials.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import {
  ReleaseError,
  type LocalReleaseArchive,
  type ReleaseArchiveInput,
} from "@spiritdevs/contracts/releases";
import type { AscCredential } from "@spiritdevs/backend/appStoreConnectApi";
import type { UploadSource } from "@spiritdevs/backend/appStoreReleaseApi";
import { runXcodeProcess, type XcodeProcessRunner } from "../xcode/XcodeProcess.ts";

const isReleaseError = Schema.is(ReleaseError);
export const releaseError = (code: ReleaseError["code"], message: string) =>
  new ReleaseError({ code, message });
export interface ReleaseHost {
  recover(): Promise<void>;
  archive(
    input: ReleaseArchiveInput,
    id: string,
    buildNumber: string,
    bundleId: string,
    credential: AscCredential,
    signal: AbortSignal,
    phase: (phase: string) => Promise<void>,
  ): Promise<
    Pick<LocalReleaseArchive, "archivePath" | "artifactPath" | "artifactSha256" | "artifactBytes">
  >;
  source(archive: LocalReleaseArchive): Promise<UploadSource>;
}
const archiveMetadata = Schema.Struct({
  ApplicationProperties: Schema.Struct({
    CFBundleIdentifier: Schema.String,
    CFBundleShortVersionString: Schema.String,
    CFBundleVersion: Schema.String,
  }),
});
export async function sha256File(file: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
const xml = (value: string) =>
  value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
export function releaseExportOptions(teamId: string) {
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>method</key><string>app-store-connect</string><key>destination</key><string>export</string><key>signingStyle</key><string>automatic</string><key>teamID</key><string>${xml(teamId)}</string><key>manageAppVersionAndBuildNumber</key><false/><key>uploadSymbols</key><true/></dict></plist>`;
}
export class MacReleaseHost implements ReleaseHost {
  readonly #root: string;
  readonly #platform: string;
  readonly #run: XcodeProcessRunner;
  constructor(root: string, platform: string, run: XcodeProcessRunner = runXcodeProcess) {
    this.#root = root;
    this.#platform = platform;
    this.#run = run;
  }
  async recover() {
    await NodeFSP.rm(NodePath.join(this.#root, "keys"), { recursive: true, force: true });
  }
  async archive(
    input: ReleaseArchiveInput,
    id: string,
    buildNumber: string,
    bundleId: string,
    credential: AscCredential,
    signal: AbortSignal,
    phase: (phase: string) => Promise<void>,
  ) {
    if (this.#platform !== "darwin")
      throw releaseError("needs-mac", "Archive and export require a Mac environment.");
    if (
      !NodePath.isAbsolute(input.projectPath) ||
      !/\.(xcodeproj|xcworkspace)$/u.test(input.projectPath) ||
      !/^\d+(?:\.\d+){0,2}$/u.test(input.version) ||
      !/^[A-Za-z0-9]{10}$/u.test(input.teamId)
    )
      throw releaseError(
        "invalid-input",
        "Choose an Xcode project or workspace, team, scheme and numeric version.",
      );
    await NodeFSP.access(input.projectPath);
    const directory = NodePath.join(this.#root, "archives", id);
    const archivePath = NodePath.join(directory, "App.xcarchive");
    const exportPath = NodePath.join(directory, "export");
    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
    const keys = NodePath.join(this.#root, "keys");
    await NodeFSP.mkdir(keys, { recursive: true, mode: 0o700 });
    const secretDir = await NodeFSP.mkdtemp(NodePath.join(keys, "run-"));
    await NodeFSP.chmod(secretDir, 0o700);
    try {
      const keyPath = NodePath.join(secretDir, `AuthKey_${credential.keyId}.p8`);
      await NodeFSP.writeFile(keyPath, credential.privateKey, { mode: 0o600, flag: "wx" });
      const auth = [
        "-allowProvisioningUpdates",
        "-authenticationKeyPath",
        keyPath,
        "-authenticationKeyID",
        credential.keyId,
        "-authenticationKeyIssuerID",
        credential.issuerId,
      ];
      // Automatic export cloud-signs when no local distribution identity is present.
      // Refuse a local identity instead of altering the user's keychain or minting a certificate.
      const identities = await this.#run(
        { file: "/usr/bin/security", args: ["find-identity", "-v", "-p", "codesigning"] },
        signal,
      );
      if (
        identities
          .split("\n")
          .some(
            (line) =>
              /Apple Distribution|iPhone Distribution|3rd Party Mac Developer/iu.test(line) &&
              line.includes(input.teamId),
          )
      )
        throw releaseError(
          "signing-configuration",
          "Use a Mac keychain without a local distribution identity for this team so Xcode can use cloud-managed signing.",
        );
      const destination = {
        IOS: "generic/platform=iOS",
        MAC_OS: "generic/platform=macOS",
        TV_OS: "generic/platform=tvOS",
        VISION_OS: "generic/platform=visionOS",
      }[input.platform];
      await phase("archiving");
      await this.#run(
        {
          file: "/usr/bin/xcodebuild",
          args: [
            "-quiet",
            input.projectPath.endsWith(".xcworkspace") ? "-workspace" : "-project",
            input.projectPath,
            "-scheme",
            input.scheme,
            "-configuration",
            "Release",
            "-destination",
            destination,
            "-archivePath",
            archivePath,
            ...auth,
            "archive",
            "CODE_SIGN_STYLE=Automatic",
            "CODE_SIGN_IDENTITY=Apple Development",
            `DEVELOPMENT_TEAM=${input.teamId}`,
            `CURRENT_PROJECT_VERSION=${buildNumber}`,
            `MARKETING_VERSION=${input.version}`,
          ],
          cwd: NodePath.dirname(input.projectPath),
          timeoutMs: 2 * 60 * 60_000,
        },
        signal,
      );
      const raw = await this.#run(
        {
          file: "/usr/bin/plutil",
          args: ["-convert", "json", "-o", "-", NodePath.join(archivePath, "Info.plist")],
        },
        signal,
      );
      const metadata = Schema.decodeUnknownSync(Schema.fromJsonString(archiveMetadata))(
        raw,
      ).ApplicationProperties;
      if (
        metadata.CFBundleIdentifier !== bundleId ||
        metadata.CFBundleShortVersionString !== input.version ||
        metadata.CFBundleVersion !== buildNumber
      )
        throw releaseError(
          "artifact-changed",
          "The archive's bundle, version or build number differs from the allocated release.",
        );
      const options = NodePath.join(directory, "ExportOptions.plist");
      await NodeFSP.writeFile(options, releaseExportOptions(input.teamId), { mode: 0o600 });
      await phase("exporting");
      await this.#run(
        {
          file: "/usr/bin/xcodebuild",
          args: [
            "-quiet",
            "-exportArchive",
            "-archivePath",
            archivePath,
            "-exportPath",
            exportPath,
            "-exportOptionsPlist",
            options,
            ...auth,
          ],
          timeoutMs: 2 * 60 * 60_000,
        },
        signal,
      );
      const artifacts = (await NodeFSP.readdir(exportPath)).filter((name) =>
        name.endsWith(input.platform === "MAC_OS" ? ".pkg" : ".ipa"),
      );
      if (artifacts.length !== 1)
        throw releaseError("archive-failed", "Xcode did not export exactly one app package.");
      const artifactPath = NodePath.join(exportPath, artifacts[0]!);
      return {
        archivePath,
        artifactPath,
        artifactBytes: (await NodeFSP.stat(artifactPath)).size,
        artifactSha256: await sha256File(artifactPath),
      };
    } catch (error) {
      if (signal.aborted) throw releaseError("cancelled", "The archive operation stopped.");
      if (isReleaseError(error)) throw error;
      throw releaseError(
        "archive-failed",
        "Xcode could not archive or export the app. Check the scheme, signing permissions and project configuration.",
      );
    } finally {
      await NodeFSP.rm(secretDir, { recursive: true, force: true });
    }
  }
  async source(archive: LocalReleaseArchive): Promise<UploadSource> {
    try {
      // Capture the file's stat before hashing so a replacement between verification and
      // upload is rejected by the Blob's subsequent reads as well.
      const blob = (await NodeFS.openAsBlob(archive.artifactPath)) as import("node:buffer").Blob;
      if ((await sha256File(archive.artifactPath)) !== archive.artifactSha256)
        throw releaseError(
          "artifact-changed",
          "The exported app changed. Prepare a new archive and confirmation.",
        );
      // File-backed Blob keeps memory bounded and fails if the artifact changes while streaming.
      if (blob.size !== archive.artifactBytes)
        throw releaseError("artifact-changed", "The exported app changed.");
      return {
        name: NodePath.basename(archive.artifactPath),
        size: blob.size,
        slice: (offset, length) => blob.slice(offset, offset + length),
      };
    } catch (error) {
      if (isReleaseError(error)) throw error;
      throw releaseError("not-found", "The exported app is unavailable on this environment.");
    }
  }
}
