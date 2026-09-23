import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

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

  it.layer(NodeServices.layer)((it) => {
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
