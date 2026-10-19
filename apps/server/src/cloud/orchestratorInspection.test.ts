import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { OrchestrationV2ThreadProjection } from "@spiritdevs/contracts";
import { readProjectInspection, readThreadInspection } from "./orchestratorInspection.ts";

it.layer(NodeServices.layer)("coordinator project inspection", (it) => {
  it.effect("reads a line page without changing the file and rejects symlink escapes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const outside = yield* fs.makeTempDirectoryScoped();
      const original = Array.from({ length: 450 }, (_, i) => `content ${i + 1}`).join("\n");
      yield* fs.writeFileString(path.join(root, "source.txt"), original);
      yield* fs.writeFileString(path.join(outside, "private.txt"), "Outside project");
      yield* fs.symlink(path.join(outside, "private.txt"), path.join(root, "escape.txt"));
      const result = yield* readProjectInspection(root, {
        kind: "readFile",
        path: "source.txt",
        startLine: 201,
      });
      expect(result).toContain("201: content 201");
      expect(result).toContain("400: content 400");
      expect(result).not.toContain("401: content 401");
      expect(result).toContain("next startLine: 401");
      expect(yield* fs.readFileString(path.join(root, "source.txt"))).toBe(original);
      expect(
        (yield* readProjectInspection(root, { kind: "readFile", path: "escape.txt" }).pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      expect(yield* readProjectInspection(root, { kind: "listFiles", path: "." })).toContain(
        "source.txt",
      );
    }).pipe(Effect.scoped),
  );
  it.effect("refuses directories and binary data as file content", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFile(path.join(root, "binary"), new Uint8Array([65, 0, 66]));
      expect(
        (yield* readProjectInspection(root, { kind: "readFile", path: "binary" }).pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      expect(
        (yield* readProjectInspection(root, { kind: "readFile", path: "." }).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
    }).pipe(Effect.scoped),
  );
});

describe("coordinator thread inspection", () => {
  it("returns visible messages and supports paging without hidden or streaming content", () => {
    const projection = {
      thread: { id: "thread", title: "Review", branch: "feature", worktreePath: null },
      runs: [{ status: "completed" }],
      messages: [
        { id: "one", role: "user", text: "Check this", streaming: false },
        { id: "hidden", role: "system", text: "Private system prompt", streaming: false },
        { id: "two", role: "assistant", text: "Verified result", streaming: false },
        { id: "three", role: "assistant", text: "Unfinished", streaming: true },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const result = readThreadInspection(projection);
    expect(result).toContain("Verified result");
    expect(result).not.toContain("Private system prompt");
    expect(result).not.toContain("Unfinished");
    expect(readThreadInspection(projection, "two")).toContain("Check this");
    expect(readThreadInspection(projection, "two")).not.toContain("Verified result");
    const long = {
      ...projection,
      messages: [{ ...projection.messages[2]!, text: "A".repeat(20000) + "Final evidence" }],
    };
    expect(readThreadInspection(long, undefined, "two", 14000)).toContain("Final evidence");
    expect(readThreadInspection(long, undefined, "two", 0)).toContain("next startCharacter: 14000");
  });
});
