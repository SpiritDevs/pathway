import {
  PREVIEW_AUTOMATION_OPERATIONS,
  PreviewRemoteError,
  type PreviewRemoteCommand,
  type PreviewRemoteFrame,
  type PreviewRemoteResult,
  type ThreadId,
  type EnvironmentId,
  type OrchestrationV2ThreadProjection,
} from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { issueAssetUrl } from "../assets/AssetAccess.ts";
import { type BrowserArtifact, RemoteBrowserRuntime } from "./RemoteBrowserRuntime.ts";

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

interface RemoteBrowserDependencies {
  readonly runtime: Pick<
    RemoteBrowserRuntime,
    "command" | "automate" | "subscribe" | "closeThread"
  >;
  readonly broker: PreviewAutomationBroker["Service"];
  readonly environmentId: EnvironmentId;
  readonly getThreadProjection: (threadId: ThreadId) => Effect.Effect<
    {
      readonly thread: Pick<
        OrchestrationV2ThreadProjection["thread"],
        "deletedAt" | "browserTakeover"
      >;
      readonly runs: ReadonlyArray<Pick<OrchestrationV2ThreadProjection["runs"][number], "status">>;
    },
    Effect.Error<ReturnType<ThreadManagementService["Service"]["getThreadProjection"]>>
  >;
  readonly deletedThreads: Stream.Stream<
    ThreadId,
    Effect.Error<ReturnType<ThreadManagementService["Service"]["getThreadProjection"]>>
  >;
  readonly signArtifact: (
    capture: BrowserArtifact,
  ) => Effect.Effect<BrowserArtifact & { url: string }, PreviewRemoteError>;
}

export const makeRemoteBrowser = Effect.fn("RemoteBrowser.make")(function* ({
  runtime,
  broker,
  environmentId,
  getThreadProjection,
  deletedThreads,
  signArtifact,
}: RemoteBrowserDependencies) {
  const unavailable = () =>
    new PreviewRemoteError({ detail: "The browser's task is unavailable." });
  const frameQueues = new Map<
    ThreadId,
    Set<Queue.Enqueue<PreviewRemoteFrame, PreviewRemoteError>>
  >();
  const closeThread = Effect.fn("RemoteBrowser.closeDeletedThread")(function* (threadId: ThreadId) {
    for (const queue of frameQueues.get(threadId) ?? []) yield* Queue.fail(queue, unavailable());
    frameQueues.delete(threadId);
    yield* operation(() => runtime.closeThread(threadId)).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Failed to close deleted task browser", { threadId, error }),
      ),
    );
  });
  const checkAvailable = Effect.fn("RemoteBrowser.checkAvailable")(function* (threadId: ThreadId) {
    const projection = yield* getThreadProjection(threadId).pipe(Effect.mapError(unavailable));
    if (projection.thread.deletedAt !== null) {
      yield* closeThread(threadId);
      return yield* unavailable();
    }
    return projection;
  });
  yield* deletedThreads.pipe(Stream.runForEach(closeThread), Effect.forkScoped);
  const clientId = `environment-browser:${environmentId}`;
  const requests = yield* broker.connect({
    clientId,
    environmentId,
    supportedOperations: PREVIEW_AUTOMATION_OPERATIONS,
  });
  yield* requests.pipe(
    Stream.runForEach((event) => {
      if (event.type === "connected") return Effect.void;
      return checkAvailable(event.request.threadId).pipe(
        Effect.andThen(() => operation(() => runtime.automate(event.request))),
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
      yield* checkAvailable(input.threadId);
      yield* selectHost(input.host === "environment" ? clientId : null);
      return { tabs: [], selectedTabId: null };
    }
    const checkControl = Effect.gen(function* () {
      const projection = yield* checkAvailable(input.threadId);
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
      runtime.command(input, () => Effect.runPromise(checkControl)),
    );
    const { artifact, artifacts, ...state } = result;
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
            yield* checkAvailable(input.threadId);
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                const queues = frameQueues.get(input.threadId) ?? new Set();
                queues.add(queue);
                frameQueues.set(input.threadId, queues);
              }),
              () =>
                Effect.sync(() => {
                  const queues = frameQueues.get(input.threadId);
                  queues?.delete(queue);
                  if (queues?.size === 0) frameQueues.delete(input.threadId);
                }),
            );
            yield* Effect.acquireRelease(
              operation(() =>
                runtime.subscribe(input.threadId, input.tabId, (frame) => {
                  Queue.offerUnsafe(queue, frame);
                }),
              ),
              (unsubscribe) => Effect.promise(unsubscribe),
            );
            // A deletion may commit while the browser subscription is opening.
            yield* checkAvailable(input.threadId);
          }).pipe(Effect.catch((error) => Queue.fail(queue, error))),
        { bufferSize: 1, strategy: "sliding" },
      ),
  } satisfies RemoteBrowserService;
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
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new RemoteBrowserRuntime(path.join(config.stateDir, "browser"), config.attachmentsDir),
      ),
      (browser) => Effect.promise(() => browser.close()),
    );
    // Capture the durable cursor before exposing any browser entry point. A live-only
    // subscription could miss a deletion committed before its worker starts reading.
    const snapshot = yield* threads.getShellSnapshot();
    let afterSequence = snapshot.snapshotSequence;
    const deletedThreads = Stream.unwrap(
      Effect.sync(() => threads.streamStoredEventsFrom({ afterSequence })),
    ).pipe(
      Stream.tap((stored) =>
        Effect.sync(() => {
          afterSequence = stored.sequence;
        }),
      ),
      Stream.filter((stored) => stored.event.type === "thread.deleted"),
      Stream.map((stored) => stored.event.threadId),
      Stream.tapError((error) =>
        Effect.logWarning("Retrying browser task deletion stream", { error }),
      ),
      Stream.retry(Schedule.spaced("1 second")),
    );
    return yield* makeRemoteBrowser({
      runtime,
      broker,
      environmentId,
      getThreadProjection: threads.getThreadProjection,
      deletedThreads,
      signArtifact: (capture) =>
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
        ),
    });
  }),
);
