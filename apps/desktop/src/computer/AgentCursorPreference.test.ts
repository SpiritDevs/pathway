import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  normalizeAgentCursorStylePreference,
  parseAgentCursorPreference,
  readAgentCursorPreference,
  writeAgentCursorPreference,
} from "./AgentCursorPreference.ts";

const decodeStoredJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

describe("normalizeAgentCursorStylePreference", () => {
  it("keeps usable channels, lowercased, and drops everything else", () => {
    assert.deepStrictEqual(
      normalizeAgentCursorStylePreference({ fill: " #AABBCC ", rim: "#0f0f0f", shadow: "red" }),
      { fill: "#aabbcc", rim: "#0f0f0f" },
    );
    assert.isNull(normalizeAgentCursorStylePreference({ fill: "#12345" }));
    assert.isNull(normalizeAgentCursorStylePreference({ fill: 12 }));
    assert.isNull(normalizeAgentCursorStylePreference({}));
    assert.isNull(normalizeAgentCursorStylePreference(null));
    assert.isNull(normalizeAgentCursorStylePreference("not-a-style"));
    assert.isNull(normalizeAgentCursorStylePreference(["#aabbcc"]));
  });
});

describe("parseAgentCursorPreference", () => {
  it("accepts only the versioned shape and normalizes the style through it", () => {
    assert.deepStrictEqual(parseAgentCursorPreference({ version: 1, style: { fill: "#AABBCC" } }), {
      version: 1,
      style: { fill: "#aabbcc" },
    });
    // A stored payload whose channels all became unusable reads as stock,
    // because the version is valid even though the style normalizes to null.
    assert.deepStrictEqual(parseAgentCursorPreference({ version: 1, style: { fill: "bad" } }), {
      version: 1,
      style: null,
    });
    assert.isNull(parseAgentCursorPreference({ version: 2, style: { fill: "#aabbcc" } }));
    assert.isNull(parseAgentCursorPreference({ style: { fill: "#aabbcc" } }));
    assert.isNull(parseAgentCursorPreference(null));
  });
});

describe("agent cursor preference filesystem", () => {
  it.effect("round-trips custom colors and restores stock by deleting the file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pathway-agent-cursor-",
      });
      const filePath = path.join(directory, "nested", "agent-cursor-colors.json");

      assert.isNull(yield* readAgentCursorPreference(filePath));

      yield* writeAgentCursorPreference(filePath, { fill: "#AABBCC", rim: "#112233" });
      assert.deepStrictEqual(yield* readAgentCursorPreference(filePath), {
        fill: "#aabbcc",
        rim: "#112233",
      });
      const stored = yield* fileSystem.readFileString(filePath);
      assert.isTrue(stored.endsWith("}\n"));
      assert.deepStrictEqual(yield* decodeStoredJson(stored), {
        version: 1,
        style: { fill: "#aabbcc", rim: "#112233" },
      });

      // Stock removes the override rather than storing an empty one.
      yield* writeAgentCursorPreference(filePath, null);
      assert.isFalse(yield* fileSystem.exists(filePath));
      assert.isNull(yield* readAgentCursorPreference(filePath));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads stock from malformed or arbitrary JSON", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pathway-agent-cursor-",
      });
      const filePath = path.join(directory, "agent-cursor-colors.json");

      yield* fileSystem.writeFileString(filePath, "{ not json");
      assert.isNull(yield* readAgentCursorPreference(filePath));

      yield* fileSystem.writeFileString(filePath, '{"version":1,"style":{"rim":"purple"}}');
      assert.isNull(yield* readAgentCursorPreference(filePath));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
