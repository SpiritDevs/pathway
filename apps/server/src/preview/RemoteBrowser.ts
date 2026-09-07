import {
  PREVIEW_AUTOMATION_OPERATIONS,
  PreviewRemoteError,
  type PreviewRemoteCommand,
  type PreviewRemoteFrame,
  type PreviewRemoteResult,
  type ThreadId,
} from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { issueAssetUrl } from "../assets/AssetAccess.ts";
import { RemoteBrowserRuntime } from "./RemoteBrowserRuntime.ts";

export interface RemoteBrowserService {
  readonly command: (
    input: PreviewRemoteCommand,
  ) => Effect.Effect<PreviewRemoteResult, PreviewRemoteError>;
  readonly frames: (input: {
    readonly threadId: ThreadId;
    readonly tabId?: string | undefined;
  }) => Stream.Stream<PreviewRemoteFrame, PreviewRemoteError>;
}
export const RemoteBrowser = Context.Reference<RemoteBrowserService>(
  "@spiritdevs/pathway/RemoteBrowser",
  {
    defaultValue: () => ({
      command: () =>
        Effect.fail(
          new PreviewRemoteError({
            detail:
              "This environment does not support hosted browsers. Update Pathway on the environment.",
          }),
        ),
      frames: () =>
        Stream.fail(
          new PreviewRemoteError({ detail: "This environment does not support hosted browsers." }),
        ),
    }),
  },
);

const operation = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new PreviewRemoteError({
        detail: cause instanceof Error ? cause.message : "The browser operation failed.",
      }),
  });

export const layer = Layer.effect(
  RemoteBrowser,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    const broker = yield* PreviewAutomationBroker;
    const environment = yield* ServerEnvironment;
    const threads = yield* ThreadManagementService;
    const environmentId = yield* environment.getEnvironmentId;
    const assetContext = yield* Effect.context<Effect.Services<ReturnType<typeof issueAssetUrl>>>();
    const threadContext = yield* Effect.context<ThreadManagementService>();
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new RemoteBrowserRuntime(path.join(config.stateDir, "browser"), config.attachmentsDir),
      ),
      (browser) => Effect.promise(() => browser.close()),
    );
    const clientId = `environment-browser:${environmentId}`;
    const requests = yield* broker.connect({
      clientId,
      environmentId,
      supportedOperations: PREVIEW_AUTOMATION_OPERATIONS,
    });
    yield* requests.pipe(
      Stream.runForEach((event) => {
        if (event.type === "connected") return Effect.void;
        return operation(() => runtime.automate(event.request)).pipe(
          Effect.matchEffect({
            onSuccess: (result) =>
              broker.respond({
                clientId,
                connectionId: event.connectionId,
                requestId: event.request.requestId,
                ok: true,
                result,
              }),
            onFailure: (error) =>
              broker.respond({
                clientId,
                connectionId: event.connectionId,
                requestId: event.request.requestId,
                ok: false,
                error: { _tag: error._tag, message: error.message },
              }),
          }),
          Effect.catch(() => Effect.void),
          Effect.forkScoped,
          Effect.asVoid,
        );
      }),
      Effect.forkScoped,
    );

    const command = Effect.fn("RemoteBrowser.command")(function* (input: PreviewRemoteCommand) {
      const selectHost = (host: string | null) =>
        broker
          .selectHostForThread({ environmentId, threadId: input.threadId, clientId: host })
          .pipe(Effect.mapError((error) => new PreviewRemoteError({ detail: error.message })));
      if (input.action === "selectHost") {
        yield* threads
          .getThreadProjection(input.threadId)
          .pipe(
            Effect.mapError(
              () => new PreviewRemoteError({ detail: "The browser's task is unavailable." }),
            ),
          );
        yield* selectHost(input.host === "environment" ? clientId : null);
        return { tabs: [], selectedTabId: null };
      }
      const checkControl = Effect.gen(function* () {
        const projection = yield* threads
          .getThreadProjection(input.threadId)
          .pipe(
            Effect.mapError(
              () => new PreviewRemoteError({ detail: "The browser's task is unavailable." }),
            ),
          );
        const viewing =
          input.action === "list" ||
          input.action === "screenshot" ||
          input.action === "recordingStart" ||
          input.action === "recordingStop";
        const agentRunning = projection.runs.some((run) =>
          ["preparing", "starting", "running"].includes(run.status),
        );
        if (!viewing && agentRunning && projection.thread.browserTakeover?.status !== "active") {
          return yield* new PreviewRemoteError({
            detail: "Take browser control before interacting while the agent is working.",
          });
        }
      });
      yield* checkControl;
      if (input.action !== "list") yield* selectHost(clientId);
      // Recheck inside the tab's action queue: takeover can end while a prior action finishes.
      const result = yield* operation(() =>
        runtime.command(input, () =>
          Effect.runPromise(checkControl.pipe(Effect.provide(threadContext))),
        ),
      );
      const { artifact, artifacts, ...state } = result;
      const signArtifact = (capture: NonNullable<typeof artifact>) =>
        issueAssetUrl({
          resource: { _tag: "attachment", attachmentId: capture.id, mimeType: capture.mimeType },
        }).pipe(
          Effect.provide(assetContext),
          Effect.map((asset) => ({ ...capture, url: asset.relativeUrl })),
          Effect.mapError(
            () =>
              new PreviewRemoteError({
                detail: "The capture was saved but its download link could not be created.",
              }),
          ),
        );
      const selectedHost = yield* broker.getSelectedHostForThread({
        environmentId,
        threadId: input.threadId,
      });
      const signed = yield* Effect.forEach(artifacts, signArtifact, { concurrency: 4 });
      return {
        ...state,
        host: selectedHost === clientId ? ("environment" as const) : ("automatic" as const),
        artifacts: signed,
        ...(artifact ? { artifact: yield* signArtifact(artifact) } : {}),
      };
    });

    return {
      command,
      frames: (input) =>
        Stream.callback<PreviewRemoteFrame, PreviewRemoteError>(
          (queue) =>
            Effect.gen(function* () {
              yield* threads
                .getThreadProjection(input.threadId)
                .pipe(
                  Effect.mapError(
                    () => new PreviewRemoteError({ detail: "The browser's task is unavailable." }),
                  ),
                );
              yield* Effect.acquireRelease(
                operation(() =>
                  runtime.subscribe(input.threadId, input.tabId, (frame) => {
                    Queue.offerUnsafe(queue, frame);
                  }),
                ),
                (unsubscribe) => Effect.promise(unsubscribe),
              );
            }),
          { bufferSize: 1, strategy: "sliding" },
        ),
    } satisfies RemoteBrowserService;
  }),
);
