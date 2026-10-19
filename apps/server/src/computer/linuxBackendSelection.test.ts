import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  COMPUTER_BACKEND_OVERRIDES,
  isLinuxBackendChoice,
  parseComputerBackendOverride,
  selectLinuxBackend,
} from "./linuxBackendSelection.ts";

describe("parseComputerBackendOverride", () => {
  it.effect("accepts every backend the server can name, case-insensitively", () =>
    Effect.gen(function* () {
      for (const choice of COMPUTER_BACKEND_OVERRIDES) {
        expect(yield* parseComputerBackendOverride(choice.toUpperCase())).toBe(choice);
        expect(yield* parseComputerBackendOverride(` ${choice} `)).toBe(choice);
      }
      expect(yield* parseComputerBackendOverride(undefined)).toBeUndefined();
      expect(yield* parseComputerBackendOverride("  ")).toBeUndefined();
    }),
  );

  it.effect("fails on a typo instead of silently booting the wrong backend", () =>
    Effect.gen(function* () {
      // Every other env var here degrades to a default on bad input. This one
      // names the backend, so ignoring it would look like the override is broken.
      const error = yield* Effect.flip(parseComputerBackendOverride("protal"));
      expect(error._tag).toBe("InvalidComputerBackendOverrideError");
      expect(error.message).toContain('PATHWAY_COMPUTER_BACKEND="protal"');
      expect(error.message).toContain("cua");
    }),
  );

  it.effect("has no shared-seat backend to name", () =>
    Effect.gen(function* () {
      // Nothing in the tree drives the human's own seat, so a portal backend is
      // simply not a backend Pathway has — the same refusal as any typo.
      const error = yield* Effect.flip(parseComputerBackendOverride("portal"));
      expect(error._tag).toBe("InvalidComputerBackendOverrideError");
    }),
  );

  it("tells the platform-neutral backends apart from the Linux tiers", () => {
    expect(isLinuxBackendChoice("fake")).toBe(false);
    expect(isLinuxBackendChoice("cua")).toBe(false);
    expect(isLinuxBackendChoice(undefined)).toBe(false);
  });
});

describe("selectLinuxBackend", () => {
  it.effect("claims no host without an override when no tier is registered", () =>
    Effect.gen(function* () {
      expect(yield* selectLinuxBackend({ env: {} })).toBeUndefined();
    }),
  );
});
