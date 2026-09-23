import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  assertCuaArtifactProvenance,
  assertCuaSidecarChecksums,
  assertLinuxCuaBinaryIdentity,
  assertLinuxCuaBuildHost,
  assertLinuxCuaSidecarChecksums,
  type CuaArch,
  type CuaArtifactProvenance,
  type CuaPlatform,
  CUA_DRIVER_SIGN_IDENTIFIER,
  LINUX_CUA_INPUT_SCOPE,
  LINUX_CUA_SIDECAR_PATHS,
} from "./cua-artifact-provenance.ts";

const release = {
  version: "0.28.2",
  source: "source-commit",
  sha256: "upstream-archive",
  nativeRevision: 32,
  patchSha256: "mac-base-checksum",
  linuxBrowserPatchSha256: "linux-delta-checksum",
  linuxBrowserInputControl: 1,
  rustVersion: "1.97.1",
};

const provenance = (overrides: Partial<CuaArtifactProvenance> = {}): CuaArtifactProvenance => ({
  version: release.version,
  source: release.source,
  nativeRevision: release.nativeRevision,
  patchSha256: release.patchSha256,
  rustVersion: release.rustVersion,
  rustcVersion: "rustc 1.97.1 (pinned-compiler)",
  binarySha256: "binary-checksum",
  architectures: ["arm64"],
  ...overrides,
});

const linuxProvenance = (overrides: Partial<CuaArtifactProvenance> = {}) =>
  provenance({
    platform: "linux",
    patched: true,
    linuxBrowserPatchSha256: release.linuxBrowserPatchSha256,
    browserInputControl: 1,
    inputScope: LINUX_CUA_INPUT_SCOPE,
    ...overrides,
  });

const validate = (value: CuaArtifactProvenance, platform: CuaPlatform = "linux") =>
  assertCuaArtifactProvenance({
    provenance: value,
    release,
    platform,
    architectures: ["arm64"],
    binarySha256: "binary-checksum",
  });

// Resolves to the failure message, or undefined when the assertion passed.
const failure = <E extends { readonly message: string }>(effect: Effect.Effect<void, E>) =>
  effect.pipe(
    Effect.as(undefined),
    Effect.catch((error) => Effect.succeed(error.message)),
  );

const expectPass = <E extends { readonly message: string }>(effect: Effect.Effect<void, E>) =>
  Effect.map(failure(effect), (message) => assert.isUndefined(message));

const expectFail = <E extends { readonly message: string }>(
  effect: Effect.Effect<void, E>,
  fragment = "",
) =>
  Effect.map(failure(effect), (message) => {
    assert.isString(message);
    assert.include(message, fragment);
  });

describe("Cua platform and build provenance", () => {
  it.effect("accepts Mac artifacts with the embedded signing identifier and no Linux delta", () =>
    Effect.gen(function* () {
      const mac = provenance({ platform: "darwin", signingIdentifier: CUA_DRIVER_SIGN_IDENTIFIER });
      yield* expectPass(validate(mac, "darwin"));
      yield* expectPass(validate({ ...mac, signedIdentity: "Developer ID" }, "darwin"));
    }),
  );

  it.effect("rejects Mac artifacts built before the embedded signing identifier", () =>
    Effect.gen(function* () {
      yield* expectFail(validate(provenance({ platform: "darwin" }), "darwin"), "identifier");
      yield* expectFail(
        validate(
          provenance({ platform: "darwin", signingIdentifier: "cua-driver-1234" }),
          "darwin",
        ),
        "identifier",
      );
      // Legacy artifacts without a platform field no longer qualify either.
      yield* expectFail(
        validate(provenance({ signingIdentifier: CUA_DRIVER_SIGN_IDENTIFIER }), "darwin"),
        "platform",
      );
    }),
  );

  it.effect("accepts Linux browser-only control with both pinned patches and compiler", () =>
    expectPass(validate(linuxProvenance())),
  );

  const incompatible: ReadonlyArray<Partial<CuaArtifactProvenance>> = [
    { platform: "darwin" },
    { platform: undefined },
    { architectures: ["x64"] },
    { binarySha256: "changed" },
    { source: "different-source" },
    { nativeRevision: 31 },
    { rustVersion: "nightly" },
    { rustcVersion: "rustc 1.96.0 (wrong)" },
    { patchSha256: "different-base" },
    { linuxBrowserPatchSha256: undefined },
    { linuxBrowserPatchSha256: "different-delta" },
    { browserInputControl: undefined },
    { browserInputControl: 0 },
    { inputScope: "native-desktop" },
  ];
  for (const override of incompatible) {
    it.effect(`rejects incompatible reusable Linux artifact ${JSON.stringify(override)}`, () =>
      expectFail(validate(linuxProvenance(override))),
    );
  }

  it.effect("keeps unpatched Windows and old Linux artifacts explicit without input claims", () =>
    Effect.gen(function* () {
      for (const platform of ["win32", "linux"] as const) {
        const unpatched = provenance({ platform, patched: false, patchSha256: null });
        yield* expectPass(validate(unpatched, platform));
        yield* expectFail(
          validate({ ...unpatched, browserInputControl: 1 }, platform),
          "unpatched",
        );
        yield* expectFail(
          validate(
            { ...unpatched, linuxBrowserPatchSha256: release.linuxBrowserPatchSha256 },
            platform,
          ),
          "unpatched",
        );
      }
    }),
  );

  it.effect("rejects cross-platform provenance even when the binary digest matches", () =>
    Effect.gen(function* () {
      yield* expectFail(validate(linuxProvenance(), "darwin"), "platform");
      yield* expectFail(validate(provenance(), "linux"), "platform");
      yield* expectFail(validate(provenance({ platform: "win32" }), "win32"), "patch");
    }),
  );

  it.effect(
    "only builds Linux on its native architecture but permits artifact verification elsewhere",
    () =>
      Effect.gen(function* () {
        const request = {
          platform: "linux",
          arch: "arm64",
          hostPlatform: "linux",
          hostArch: "arm64",
        } as const;
        yield* expectPass(assertLinuxCuaBuildHost(request));
        yield* expectFail(
          assertLinuxCuaBuildHost({ ...request, hostPlatform: "darwin" }),
          "native linux/arm64",
        );
        yield* expectFail(assertLinuxCuaBuildHost({ ...request, hostArch: "x64" }));
        yield* expectPass(
          assertLinuxCuaBuildHost({
            ...request,
            hostPlatform: "darwin",
            artifact: "/verified-later",
          }),
        );
      }),
  );

  it.effect("verifies actual ELF architecture independently of provenance labels", () =>
    Effect.gen(function* () {
      const elf = new Uint8Array(20);
      elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
      const setMachine = (machine: number) => new DataView(elf.buffer).setUint16(18, machine, true);
      const identity = (bytes: Uint8Array, architectures: ReadonlyArray<CuaArch>) =>
        assertLinuxCuaBinaryIdentity(bytes, architectures);
      setMachine(183);
      yield* expectPass(identity(elf, ["arm64"]));
      yield* expectFail(identity(elf, ["x64"]), "ELF");
      yield* expectFail(identity(new TextEncoder().encode("MZ-windows"), ["arm64"]), "ELF");
      setMachine(62);
      yield* expectPass(identity(elf, ["x64"]));
    }),
  );

  it.effect("requires every staged Linux helper byte to match the recorded checksum", () =>
    Effect.gen(function* () {
      const checksums = Object.fromEntries(
        LINUX_CUA_SIDECAR_PATHS.map((path) => [path, `sha:${path}`]),
      );
      const value = linuxProvenance({ sidecarSha256: checksums });
      yield* expectPass(assertLinuxCuaSidecarChecksums(value, checksums));
      yield* expectFail(
        assertLinuxCuaSidecarChecksums(value, { ...checksums, "cua-cursor-theme": "changed" }),
        "sidecar",
      );
      yield* expectFail(assertLinuxCuaSidecarChecksums(value, {}), "sidecar");
      yield* expectFail(assertLinuxCuaSidecarChecksums(linuxProvenance(), checksums), "sidecar");
    }),
  );

  it.effect("requires exactly the recorded sidecars, byte for byte", () =>
    Effect.gen(function* () {
      const checksums = { "cua-cursor-theme.exe": "a", "uia/helper.dll": "b" };
      const value = provenance({ platform: "win32", patched: false, sidecarSha256: checksums });
      yield* expectPass(assertCuaSidecarChecksums(value, checksums));
      yield* expectPass(assertCuaSidecarChecksums(provenance({ sidecarSha256: {} }), {}));
      yield* expectFail(
        assertCuaSidecarChecksums(value, { ...checksums, "uia/helper.dll": "swapped" }),
        "sidecar",
      );
      yield* expectFail(
        assertCuaSidecarChecksums(value, { ...checksums, "injected.dll": "c" }),
        "sidecar",
      );
      yield* expectFail(
        assertCuaSidecarChecksums(value, { "cua-cursor-theme.exe": "a" }),
        "sidecar",
      );
      yield* expectFail(assertCuaSidecarChecksums(provenance(), {}), "sidecar");
    }),
  );
});
