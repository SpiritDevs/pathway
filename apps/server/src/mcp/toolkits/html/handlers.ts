import { OrchestratorMcpFailure, type RunId } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { HtmlRender } from "../../../htmlRender/HtmlRender.ts";
import {
  latestActiveRun,
  ThreadManagementService,
} from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { HtmlPreviewToolkit, HtmlRenderToolkit, type HtmlToolkit } from "./tools.ts";

const toFailure = (error: { readonly _tag: string; readonly message: string }) =>
  new OrchestratorMcpFailure({
    code:
      error._tag === "HtmlRenderBrowserError" || error._tag === "HtmlRenderStoreError"
        ? "orchestration_error"
        : "invalid_request",
    message: error.message,
  });

const requireCaller = Effect.fn("HtmlToolkit.requireCaller")(function* (
  publish: boolean,
  expectedRunId?: RunId,
) {
  const scope = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "This MCP credential does not grant preview capabilities.",
        }),
    ),
  );
  const threads = yield* ThreadManagementService;
  const shell = yield* threads.getThreadShell(scope.threadId).pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "thread_not_found",
          message: "Unable to read the calling thread.",
        }),
    ),
  );
  if (
    shell === null ||
    shell.id !== scope.threadId ||
    shell.deletedAt !== null ||
    shell.archivedAt !== null
  ) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "HTML tools require an existing, non-deleted, non-archived calling thread.",
    });
  }
  if (!McpInvocationContext.threadShowsHtmlRenders(shell)) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Inline pages are only shown to the user. Return your findings to the agent that delegated this work instead.",
    });
  }
  if (!publish) return { scope, runId: undefined };
  const projection = yield* threads.getThreadProjection(scope.threadId).pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "thread_not_found",
          message: "Unable to read the calling thread.",
        }),
    ),
  );
  const activeRun = latestActiveRun(projection);
  if (
    projection.thread.id !== scope.threadId ||
    projection.thread.deletedAt !== null ||
    projection.thread.archivedAt !== null ||
    activeRun === undefined ||
    activeRun.rootNodeId === null ||
    activeRun.providerInstanceId !== scope.providerInstanceId ||
    (expectedRunId !== undefined && activeRun.id !== expectedRunId)
  ) {
    return yield* new OrchestratorMcpFailure({
      code: "parent_not_active",
      message: "HTML publishing requires a live active run owned by this MCP provider instance.",
    });
  }
  return { scope, runId: activeRun.id };
});

export const htmlHandlers = {
  html_preview: Effect.fn("HtmlToolkit.preview")(function* (
    input: typeof HtmlPreviewToolkit.tools.html_preview.parametersSchema.Type,
  ) {
    yield* requireCaller(false);
    const renderer = yield* HtmlRender;
    const { png, metadata } = yield* renderer.preview(input).pipe(Effect.mapError(toFailure));
    return {
      ...metadata,
      screenshot: { ...metadata.screenshot, data: Buffer.from(png).toString("base64") },
    };
  }),
  html_render: Effect.fn("HtmlToolkit.publish")(function* (
    input: typeof HtmlRenderToolkit.tools.html_render.parametersSchema.Type,
  ) {
    const { scope, runId } = yield* requireCaller(true);
    const renderer = yield* HtmlRender;
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // Uninterruptible so a saved file is always bound to the discard below; the measuring deadline bounds it.
        const reference = yield* renderer
          .publish({ ...input, threadId: scope.threadId })
          .pipe(Effect.mapError(toFailure));
        return yield* restore(requireCaller(true, runId)).pipe(
          Effect.as({
            htmlRender: reference,
            message:
              "Shown to the reader above your reply. Add only what the page does not already say.",
          }),
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : renderer
                  .discardHtmlRender(reference)
                  .pipe(
                    Effect.catch((error) => Effect.logError("html-render.discard-failed", error)),
                  ),
          ),
        );
      }),
    );
  }),
} satisfies Parameters<typeof HtmlToolkit.toLayer>[0];

export const HtmlPreviewToolkitHandlersLive = HtmlPreviewToolkit.toLayer({
  html_preview: htmlHandlers.html_preview,
});
export const HtmlRenderToolkitHandlersLive = HtmlRenderToolkit.toLayer({
  html_render: htmlHandlers.html_render,
});
