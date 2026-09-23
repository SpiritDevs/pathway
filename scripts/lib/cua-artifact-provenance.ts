import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const LINUX_CUA_INPUT_SCOPE = "owned-headless-browser";

/**
 * The macOS driver's signing identifier. It is embedded as the Mach-O's
 * `__TEXT,__info_plist`, so codesign keeps it through electron-builder's
 * identifier-less re-sign and macOS TCC grants survive updates.
 */
export const CUA_DRIVER_SIGN_IDENTIFIER = "com.spiritdevs.pathway.cua.driver";

// The CLI delegates cursor-theme authoring to the sibling executable. AT-SPI
// observations use Rust/zbus; the GNOME extension sources are also embedded in
// the driver, and these files preserve the upstream manual installation route.
export const LINUX_CUA_SIDECAR_PATHS = [
  "cua-cursor-theme",
  "wayland-helper/install.sh",
  "wayland-helper/README.md",
  "wayland-helper/winrects@cua/extension.js",
  "wayland-helper/winrects@cua/metadata.json",
] as const;

export const CuaPlatform = Schema.Literals(["darwin", "linux", "win32"]);
export type CuaPlatform = typeof CuaPlatform.Type;

export const CuaArch = Schema.Literals(["arm64", "x64"]);
export type CuaArch = typeof CuaArch.Type;

/** The pinned driver release in `packages/shared/src/cuaDriverRelease.json`. */
export const CuaDriverRelease = Schema.Struct({
  version: Schema.String,
  source: Schema.String,
  sha256: Schema.String,
  nativeRevision: Schema.Number,
  patchSha256: Schema.String,
  linuxBrowserPatchSha256: Schema.String,
  linuxBrowserInputControl: Schema.Number,
  rustVersion: Schema.String,
});
export type CuaDriverRelease = typeof CuaDriverRelease.Type;

const OptionalNullableString = Schema.optional(Schema.NullOr(Schema.String));

/**
 * `provenance.json` beside a staged driver. Every field is optional so that
 * reused artifacts from older provisioners decode and are judged by
 * `assertCuaArtifactProvenance` instead of failing as malformed JSON.
 */
export const CuaArtifactProvenance = Schema.Struct({
  version: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  nativeRevision: Schema.optional(Schema.Number),
  platform: Schema.optional(Schema.String),
  patched: Schema.optional(Schema.Boolean),
  patchSha256: OptionalNullableString,
  linuxBrowserPatchSha256: OptionalNullableString,
  browserInputControl: Schema.optional(Schema.Number),
  inputScope: OptionalNullableString,
  sidecarSha256: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  rustVersion: Schema.optional(Schema.String),
  rustcVersion: Schema.optional(Schema.String),
  architectures: Schema.optional(Schema.Array(Schema.String)),
  binarySha256: Schema.optional(Schema.String),
  upstreamArchiveSha256: Schema.optional(Schema.String),
  sourceArchiveSha256: Schema.optional(Schema.String),
  signedIdentity: Schema.optional(Schema.String),
  signingIdentifier: Schema.optional(Schema.String),
});
export type CuaArtifactProvenance = typeof CuaArtifactProvenance.Type;

export class CuaArtifactProvenanceError extends Schema.TaggedErrorClass<CuaArtifactProvenanceError>()(
  "CuaArtifactProvenanceError",
  { message: Schema.String },
) {}

const reject = (message: string) => Effect.fail(new CuaArtifactProvenanceError({ message }));

export const assertLinuxCuaBuildHost = (input: {
  readonly platform: CuaPlatform;
  readonly hostPlatform: string;
  readonly arch: string;
  readonly hostArch: string;
  readonly artifact?: string | undefined;
}) =>
  input.platform !== "linux" ||
  input.artifact ||
  (input.hostPlatform === "linux" && input.hostArch === input.arch)
    ? Effect.void
    : reject(
        `Patched Linux Cua requires a matching native linux/${input.arch} build host or a verified --artifact-dir.`,
      );

export const assertLinuxCuaBinaryIdentity = (
  bytes: Uint8Array,
  architectures: ReadonlyArray<CuaArch>,
) => {
  const machine = architectures[0] === "arm64" ? 183 : 62;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isElf =
    architectures.length === 1 &&
    bytes.length >= 20 &&
    bytes[0] === 0x7f &&
    new TextDecoder("ascii").decode(bytes.subarray(1, 4)) === "ELF" &&
    bytes[4] === 2 &&
    bytes[5] === 1 &&
    view.getUint16(18, true) === machine;
  return isElf
    ? Effect.void
    : reject("Cua Linux artifact is not an ELF executable for the requested architecture.");
};

export const assertCuaArtifactProvenance = (input: {
  readonly provenance: CuaArtifactProvenance;
  readonly release: CuaDriverRelease;
  readonly platform: CuaPlatform;
  readonly architectures: ReadonlyArray<CuaArch>;
  readonly binarySha256: string;
}) => {
  const { provenance, release, platform } = input;
  const recordedArchitectures = provenance.architectures;
  if (
    provenance.version !== release.version ||
    provenance.source !== release.source ||
    provenance.nativeRevision !== release.nativeRevision ||
    provenance.rustVersion !== release.rustVersion ||
    provenance.platform !== platform ||
    !Array.isArray(recordedArchitectures) ||
    input.architectures.some((value) => !recordedArchitectures.includes(value)) ||
    input.binarySha256 !== provenance.binarySha256
  ) {
    return reject("Cua artifact identity, platform, architecture or binary checksum mismatch.");
  }
  if (provenance.patched === false) {
    return platform === "darwin" ||
      provenance.patchSha256 != null ||
      provenance.linuxBrowserPatchSha256 != null ||
      (provenance.browserInputControl !== undefined && provenance.browserInputControl !== 0) ||
      provenance.inputScope != null
      ? reject("An unpatched Cua artifact cannot claim patched input capabilities.")
      : Effect.void;
  }
  if (platform === "win32" || provenance.patchSha256 !== release.patchSha256) {
    return reject("Cua artifact native patch checksum mismatch.");
  }
  if (
    platform === "linux" &&
    (provenance.patched !== true ||
      provenance.linuxBrowserPatchSha256 !== release.linuxBrowserPatchSha256 ||
      provenance.browserInputControl !== release.linuxBrowserInputControl ||
      provenance.browserInputControl !== 1 ||
      provenance.inputScope !== LINUX_CUA_INPUT_SCOPE ||
      typeof provenance.rustcVersion !== "string" ||
      !provenance.rustcVersion.startsWith(`rustc ${release.rustVersion} `))
  ) {
    return reject("Cua Linux browser patch, capability or compiler provenance mismatch.");
  }
  if (
    platform === "darwin" &&
    (provenance.linuxBrowserPatchSha256 != null || provenance.inputScope != null)
  ) {
    return reject("A macOS Cua artifact cannot carry Linux-only input provenance.");
  }
  if (platform === "darwin" && provenance.signingIdentifier !== CUA_DRIVER_SIGN_IDENTIFIER) {
    return reject("Cua macOS artifact lacks the embedded signing identifier; rebuild it.");
  }
  return Effect.void;
};

/** Every file staged beside the driver must be recorded, and every recorded file present. */
export const assertCuaSidecarChecksums = (
  provenance: CuaArtifactProvenance,
  checksums: Readonly<Record<string, string>>,
) => {
  const recorded = provenance.sidecarSha256;
  const staged = Object.keys(checksums);
  return recorded &&
    Object.keys(recorded).length === staged.length &&
    staged.every((path) => recorded[path] === checksums[path])
    ? Effect.void
    : reject("Cua sidecar checksum mismatch, or a sidecar is missing or unrecorded.");
};

export const assertLinuxCuaSidecarChecksums = (
  provenance: CuaArtifactProvenance,
  checksums: Readonly<Record<string, string>>,
) => {
  const recorded = provenance.sidecarSha256;
  return recorded &&
    LINUX_CUA_SIDECAR_PATHS.every(
      (path) => typeof recorded[path] === "string" && checksums[path] === recorded[path],
    )
    ? Effect.void
    : reject("Cua Linux sidecar checksum mismatch or required sidecar missing.");
};
