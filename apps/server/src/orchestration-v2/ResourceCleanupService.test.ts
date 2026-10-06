import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { createAttachmentId, createIssueAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";

const testLayer = ResourceCleanupService.live.pipe(
  Layer.provide(Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void })),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "pathway-resource-cleanup-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const writeAttachments = Effect.fn("writeAttachments")(function* (names: ReadonlyArray<string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  yield* fileSystem.makeDirectory(path.join(attachmentsDir, "nested"), { recursive: true });
  for (const name of names) {
    yield* fileSystem.writeFileString(path.join(attachmentsDir, name), name);
  }
});

const remaining = Effect.fn("remaining")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  return (yield* fileSystem.readDirectory(attachmentsDir, { recursive: true })).toSorted();
});

describe("ResourceCleanupService", () => {
  it.effect("removes listed attachments and sweeps only the deleted thread's own pages", () =>
    Effect.gen(function* () {
      const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      const listed = `${createAttachmentId("thread-a")!}.png`;
      const ownPage = `${createAttachmentId("thread-a", "html")!}.html`;
      const unprojectedPage = `${createAttachmentId("thread-a", "html")!}.html`;
      const kept = [
        `${createAttachmentId("thread-a")!}.json`,
        `${createAttachmentId("thread-a-b", "html")!}.html`,
        `${createAttachmentId("thread-b", "html")!}.html`,
        `${createIssueAttachmentId("thread-a")!}.png`,
        `${createAttachmentId("thread-a", "html")!}.html`.toUpperCase(),
        `${createAttachmentId("thread-a", "html")!}.html.part`,
        `${createAttachmentId("thread-a", "htm")!}.htm`,
        `nested/${createAttachmentId("thread-a", "html")!}.html`,
      ];
      yield* writeAttachments([listed, ownPage, unprojectedPage, ...kept]);
      // A link named like this thread's page goes away; its target is never followed.
      const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "pathway-outside-" });
      const target = path.join(outside, "target.html");
      yield* fileSystem.writeFileString(target, "outside");
      const link = `${createAttachmentId("thread-a", "html")!}.html`;
      yield* fileSystem.symlink(target, path.join(attachmentsDir, link));

      yield* cleanup.cleanupAttachments([listed.replace(/\.png$/, "")], "thread-a");

      expect(yield* remaining()).toEqual(["nested", ...kept].toSorted());
      expect(yield* fileSystem.readFileString(target)).toBe("outside");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("never sweeps without an owner, and tolerates a missing directory", () =>
    Effect.gen(function* () {
      const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
      const fileSystem = yield* FileSystem.FileSystem;
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      yield* fileSystem.remove(attachmentsDir, { recursive: true });
      yield* cleanup.cleanupAttachments([], "thread-a");
      const page = `${createAttachmentId("thread-a", "html")!}.html`;
      yield* writeAttachments([page]);

      yield* cleanup.cleanupAttachments([]);

      expect(yield* remaining()).toEqual(["nested", page].toSorted());
    }).pipe(Effect.provide(testLayer)),
  );
});
