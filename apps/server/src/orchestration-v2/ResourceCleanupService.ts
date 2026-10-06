import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  isThreadHtmlRenderAttachmentId,
  parseAttachmentIdFromRelativePath,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export class ResourceCleanupError extends Schema.TaggedErrorClass<ResourceCleanupError>()(
  "ResourceCleanupError",
  {
    operation: Schema.Literals(["terminal", "attachment"]),
    threadId: Schema.optional(Schema.String),
    attachmentId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export class ResourceCleanupService extends Context.Reference<{
  readonly cleanupTerminals: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  /**
   * Removes the given attachments. With `htmlRenderThreadId` (thread deletion only), also removes
   * every HTML render that thread minted, including pages whose tool result never projected.
   */
  readonly cleanupAttachments: (
    attachmentIds: ReadonlyArray<string>,
    htmlRenderThreadId?: string,
  ) => Effect.Effect<void, ResourceCleanupError>;
}>("@spiritdevs/pathway/orchestration-v2/ResourceCleanupService", {
  defaultValue: () => ({
    cleanupTerminals: () => Effect.void,
    cleanupAttachments: () => Effect.void,
  }),
}) {}

export const live = Layer.effect(
  ResourceCleanupService,
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;

    // One flat, non-recursive listing. Names must be exactly `<id>.html` for an id this thread
    // minted, so another thread's, an issue's, or an odd name is never touched.
    const threadHtmlRenderIds = (threadId: string) =>
      fileSystem.readDirectory(config.attachmentsDir, { recursive: false }).pipe(
        Effect.map((entries) =>
          entries.flatMap((entry) => {
            const attachmentId = parseAttachmentIdFromRelativePath(entry);
            return attachmentId !== null &&
              entry === `${attachmentId}.html` &&
              isThreadHtmlRenderAttachmentId(threadId, attachmentId)
              ? [attachmentId]
              : [];
          }),
        ),
        Effect.catchTag("PlatformError", (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed([])
            : Effect.fail(new ResourceCleanupError({ operation: "attachment", threadId, cause })),
        ),
      );

    return {
      cleanupTerminals: (threadId: string) =>
        terminals
          .close({ threadId, deleteHistory: true })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "terminal", threadId, cause }),
            ),
          ),
      cleanupAttachments: (attachmentIds: ReadonlyArray<string>, htmlRenderThreadId?: string) =>
        Effect.gen(function* () {
          const swept =
            htmlRenderThreadId === undefined ? [] : yield* threadHtmlRenderIds(htmlRenderThreadId);
          yield* Effect.forEach(
            new Set([...attachmentIds, ...swept]),
            (attachmentId) => {
              const path = resolveAttachmentPathById({
                attachmentsDir: config.attachmentsDir,
                attachmentId,
              });
              // Removing a name unlinks it; a link's target is never followed.
              return path === null
                ? Effect.void
                : fileSystem.remove(path, { force: true }).pipe(
                    Effect.mapError(
                      (cause) =>
                        new ResourceCleanupError({
                          operation: "attachment",
                          attachmentId,
                          cause,
                        }),
                    ),
                  );
            },
            { discard: true, concurrency: 4 },
          );
        }),
    };
  }),
);
