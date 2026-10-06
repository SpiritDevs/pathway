import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type HtmlRenderReference,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@spiritdevs/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { HtmlRender, HtmlRenderImagesNotFoundError } from "../../../htmlRender/HtmlRender.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import { htmlHandlers } from "./handlers.ts";

const threadId = ThreadId.make("html-handler-thread");
const providerInstanceId = ProviderInstanceId.make("codex");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("html-handler-environment"),
  threadId,
  providerInstanceId,
  providerSessionId: "credential-id-not-orchestration-session-id",
  providerDriverKind: ProviderDriverKind.make("codex"),
  capabilities: new Set(["preview"]),
  issuedAt: 1,
};
const reference: HtmlRenderReference = {
  attachmentId: "html-handler-attachment",
  title: "Chart",
  height: 400,
};
const input = { html: "<html><body>Chart</body></html>", title: "Chart", height: 400 };
const shell = {
  id: threadId,
  deletedAt: null,
  archivedAt: null,
  lineage: { relationshipToParent: null },
} as unknown as OrchestrationV2ThreadShell;
const projection = {
  thread: { id: threadId, deletedAt: null, archivedAt: null },
  runs: [
    {
      id: RunId.make("active-html-run"),
      ordinal: 1,
      status: "running",
      rootNodeId: "root",
      providerInstanceId,
    },
  ],
} as unknown as OrchestrationV2ThreadProjection;
const preview = {
  png: new Uint8Array([1, 2, 3]),
  metadata: {
    width: 728,
    contentHeight: 400,
    capturedHeight: 400,
    consoleMessages: [],
    screenshot: { mimeType: "image/png" as const, width: 728, height: 400 },
  },
};

const dependencies = (
  options: {
    readonly scope?: McpInvocationScope;
    readonly shell?: OrchestrationV2ThreadShell | null;
    readonly projection?: OrchestrationV2ThreadProjection;
    readonly getThreadShell?: ThreadManagementService["Service"]["getThreadShell"];
    readonly publish?: HtmlRender["Service"]["publish"];
    readonly discard?: HtmlRender["Service"]["discardHtmlRender"];
  } = {},
) =>
  Layer.mergeAll(
    Layer.succeed(McpInvocationContext, options.scope ?? scope),
    Layer.mock(ThreadManagementService)({
      getThreadShell:
        options.getThreadShell ??
        (() => Effect.succeed(options.shell === undefined ? shell : options.shell)),
      getThreadProjection: () => Effect.succeed(options.projection ?? projection),
    }),
    Layer.mock(HtmlRender)({
      preview: () => Effect.succeed(preview),
      publish: options.publish ?? (() => Effect.succeed(reference)),
      discardHtmlRender: options.discard ?? (() => Effect.void),
    }),
  );

it.effect("previews the caller thread without requiring an active run", () =>
  htmlHandlers.html_preview({ html: input.html }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result.screenshot.data).toBe("AQID");
        expect(result.contentHeight).toBe(400);
      }),
    ),
    Effect.provide(dependencies({ projection: { ...projection, runs: [] } })),
  ),
);

it.effect("publishes only into the authenticated thread, preserving the compact reference", () => {
  let savedThread: ThreadId | undefined;
  return htmlHandlers.html_render(input).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(savedThread).toBe(threadId);
        expect(result.htmlRender).toEqual(reference);
        expect(result).not.toHaveProperty("html");
      }),
    ),
    Effect.provide(
      dependencies({
        publish: (request) =>
          Effect.sync(() => {
            savedThread = request.threadId;
            return reference;
          }),
      }),
    ),
  );
});

for (const operation of ["html_preview", "html_render"] as const) {
  it.effect(`${operation} rejects a credential without preview capability`, () =>
    (operation === "html_preview"
      ? htmlHandlers.html_preview(input).pipe(Effect.asVoid)
      : htmlHandlers.html_render(input).pipe(Effect.asVoid)
    ).pipe(
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => expect(error.code).toBe("capability_denied"))),
      Effect.provide(dependencies({ scope: { ...scope, capabilities: new Set() } })),
    ),
  );
  for (const [label, delegatedShell] of [
    ["subagent", { ...shell, lineage: { relationshipToParent: "subagent" } }],
    ["orchestrator worker", { ...shell, orchestratorOrigin: {} }],
  ] as const) {
    it.effect(`${operation} refuses a ${label} thread because pages are only for the user`, () =>
      (operation === "html_preview"
        ? htmlHandlers.html_preview(input).pipe(Effect.asVoid)
        : htmlHandlers.html_render(input).pipe(Effect.asVoid)
      ).pipe(
        Effect.flip,
        Effect.tap((error) =>
          Effect.sync(() => {
            expect(error.code).toBe("capability_denied");
            expect(error.message).toContain("only shown to the user");
          }),
        ),
        Effect.provide(
          dependencies({ shell: delegatedShell as unknown as OrchestrationV2ThreadShell }),
        ),
      ),
    );
  }
  for (const [label, invalidShell] of [
    ["missing", null],
    ["deleted", { ...shell, deletedAt: {} }],
    ["archived", { ...shell, archivedAt: {} }],
    ["wrong", { ...shell, id: ThreadId.make("another-thread") }],
  ] as const) {
    it.effect(`${operation} rejects a ${label} caller thread before rendering`, () =>
      (operation === "html_preview"
        ? htmlHandlers.html_preview(input).pipe(Effect.asVoid)
        : htmlHandlers.html_render(input).pipe(Effect.asVoid)
      ).pipe(
        Effect.flip,
        Effect.tap((error) => Effect.sync(() => expect(error.code).toBe("thread_not_found"))),
        Effect.provide(dependencies({ shell: invalidShell as OrchestrationV2ThreadShell | null })),
      ),
    );
  }
}

for (const [label, runs] of [
  ["no active run", []],
  ["cancelled run", [{ ...projection.runs[0]!, status: "cancelled" }]],
  ["missing root", [{ ...projection.runs[0]!, rootNodeId: null }]],
  [
    "other provider",
    [{ ...projection.runs[0]!, providerInstanceId: ProviderInstanceId.make("claude") }],
  ],
] as const) {
  it.effect(`rejects publishing with ${label}`, () =>
    htmlHandlers.html_render(input).pipe(
      Effect.flip,
      Effect.tap((error) => Effect.sync(() => expect(error.code).toBe("parent_not_active"))),
      Effect.provide(
        dependencies({ projection: { ...projection, runs } as OrchestrationV2ThreadProjection }),
      ),
    ),
  );
}

it.effect("maps invalid local images to an actionable typed tool failure", () =>
  htmlHandlers.html_render(input).pipe(
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        expect(error.code).toBe("invalid_request");
        expect(error.message).toContain("/missing.png");
      }),
    ),
    Effect.provide(
      dependencies({
        publish: () => new HtmlRenderImagesNotFoundError({ paths: ["/missing.png"] }),
      }),
    ),
  ),
);

for (const race of ["deleted", "cancelled", "replaced"] as const) {
  it.effect(`discards a saved page when the calling thread/run is ${race} during save`, () => {
    let saved = false;
    const discarded: HtmlRenderReference[] = [];
    const after =
      race === "deleted" ? ({ ...shell, deletedAt: {} } as OrchestrationV2ThreadShell) : shell;
    const run = {
      ...projection.runs[0]!,
      ...(race === "cancelled"
        ? { status: "cancelled" as const }
        : { id: RunId.make("replacement-run") }),
    };
    const threads = Layer.mock(ThreadManagementService)({
      getThreadShell: () => Effect.succeed(saved ? after : shell),
      getThreadProjection: () =>
        Effect.succeed(saved ? { ...projection, runs: [run] } : projection),
    });
    return htmlHandlers.html_render(input).pipe(
      Effect.flip,
      Effect.tap(() => Effect.sync(() => expect(discarded).toEqual([reference]))),
      Effect.provide(threads),
      Effect.provide(
        dependencies({
          publish: () =>
            Effect.sync(() => {
              saved = true;
              return reference;
            }),
          discard: (value) =>
            Effect.sync(() => {
              discarded.push(value);
            }),
        }),
      ),
    );
  });
}

it.effect(
  "discards the saved page if cancellation interrupts the post-save authorization check",
  () =>
    Effect.gen(function* () {
      const rechecking = yield* Deferred.make<void>();
      let reads = 0;
      const discarded: HtmlRenderReference[] = [];
      const fiber = yield* htmlHandlers.html_render(input).pipe(
        Effect.provide(
          dependencies({
            getThreadShell: () =>
              ++reads === 1
                ? Effect.succeed(shell)
                : Deferred.succeed(rechecking, undefined).pipe(Effect.andThen(Effect.never)),
            discard: (value) =>
              Effect.sync(() => {
                discarded.push(value);
              }),
          }),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(rechecking);
      yield* Fiber.interrupt(fiber);
      expect(discarded).toEqual([reference]);
    }),
);
