import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { parse } from "yaml";

import { collectCuaCacheInputs, cuaBuildFlags, cuaCacheKey } from "./cua-cache-key.ts";

describe("Cua build cache identity", () => {
  for (const key of [
    "CARGO_BUILD_RUSTFLAGS",
    "RUSTFLAGS",
    "CARGO_PROFILE_RELEASE_STRIP",
    "CC_aarch64_apple_darwin",
    "PKG_CONFIG_ALL_STATIC",
    "RUSTC_WRAPPER",
    "SDKROOT",
    "MACOSX_DEPLOYMENT_TARGET",
    "CARGO_INCREMENTAL",
    "CARGO_TERM_COLOR",
  ]) {
    it(`fingerprints ${key}`, () => {
      assert.notStrictEqual(
        cuaCacheKey({ flags: cuaBuildFlags({ [key]: "changed" }) }),
        cuaCacheKey({ flags: cuaBuildFlags({}) }),
      );
    });
  }

  it("ignores staging paths and signing secrets", () => {
    assert.deepStrictEqual(
      cuaBuildFlags({
        CARGO_TARGET_DIR: "/tmp/random",
        CSC_KEY_PASSWORD: "secret",
        APPLE_API_KEY: "secret",
        PATHWAY_CUA_SIGN_IDENTITY: "secret",
      }),
      {},
    );
  });

  const ProvisionAction = Schema.Struct({
    runs: Schema.Struct({
      steps: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
        }),
      ),
    }),
  });

  it.layer(NodeServices.layer)((it) => {
    it.effect("fingerprints exactly the Cargo flags the cache-miss build runs with", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const action = yield* Schema.decodeUnknownEffect(ProvisionAction)(
          parse(yield* fs.readFileString(".github/actions/provision-cua/action.yml")),
        );
        const stepFlags = (name: string) =>
          cuaBuildFlags(action.runs.steps.find((step) => step.name === name)?.env ?? {});
        const fingerprinted = stepFlags("Fingerprint native build inputs");
        // A job's Rust setup (dtolnay/rust-toolchain in release.yml) exports these;
        // pinning them in the action keeps release and cache producer keys equal.
        assert.include(fingerprinted, { CARGO_INCREMENTAL: "0", CARGO_TERM_COLOR: "always" });
        assert.deepStrictEqual(stepFlags("Build on a valid cache miss"), fingerprinted);
      }),
    );

    it.effect(
      "rejects compiler wrappers whose bytes cannot be established by environment values",
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            collectCuaCacheInputs(".", { RUSTC_WRAPPER: "/tmp/compiler" }),
          );
          assert.include(error.message, "does not support");
        }),
    );
  });

  for (const key of [
    "files",
    "platform",
    "arch",
    "os",
    "rust",
    "cargo",
    "compiler",
    "sdk",
    "flags",
  ]) {
    it(`invalidates changed ${key}`, () => {
      assert.notStrictEqual(cuaCacheKey({ [key]: "before" }), cuaCacheKey({ [key]: "after" }));
    });
  }
});
