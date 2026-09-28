import type {
  PreviewRemoteInteractionCommand,
  PreviewRemoteInteractionState,
  PreviewRemoteInteractionEvent,
} from "@spiritdevs/contracts";
import * as Clock from "effect/Clock";
import type { EnvironmentSurfaceViewport } from "@spiritdevs/contracts";
import type { SurfaceSink } from "../surface/EnvironmentSurfaceStream.ts";
import type * as Scope from "effect/Scope";
import {
  environmentBrowserHostClientId,
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
import { EventStoreV2, layer as eventStoreLayer } from "../orchestration-v2/EventStore.ts";
import { issueAssetUrl } from "../assets/AssetAccess.ts";
import { type BrowserArtifact, RemoteBrowserRuntime } from "./RemoteBrowserRuntime.ts";

export interface RemoteBrowserService {
  readonly interact: (
    input: PreviewRemoteInteractionCommand,
  ) => Effect.Effect<void, PreviewRemoteError>;
  readonly interactions: (input: {
    threadId: ThreadId;
  }) => Stream.Stream<PreviewRemoteInteractionEvent, PreviewRemoteError>;
  readonly subscribeSurface: (
    input: { threadId: ThreadId; tabId: string; viewport: EnvironmentSurfaceViewport },
    sink: SurfaceSink,
  ) => Effect.Effect<void, PreviewRemoteError, Scope.Scope>;
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
      interact: () =>
        Effect.fail(new PreviewRemoteError({ detail: "Browser interactions are unavailable." })),
      interactions: () =>
        Stream.fail(new PreviewRemoteError({ detail: "Browser interactions are unavailable." })),
      subscribeSurface: () =>
        Effect.fail(new PreviewRemoteError({ detail: "Surface streaming is unavailable." })),
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
    | "command"
    | "automate"
    | "subscribe"
    | "subscribeSurface"
    | "interact"
    | "subscribeInteractions"
    | "closeThread"
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
  const interactionQueues = new Map<
    ThreadId,
    Set<Queue.Enqueue<PreviewRemoteInteractionEvent, PreviewRemoteError>>
  >();
  const closeThread = Effect.fn("RemoteBrowser.closeDeletedThread")(function* (threadId: ThreadId) {
    for (const queue of frameQueues.get(threadId) ?? []) yield* Queue.fail(queue, unavailable());
    frameQueues.delete(threadId);
    for (const queue of interactionQueues.get(threadId) ?? [])
      yield* Queue.fail(queue, unavailable());
    interactionQueues.delete(threadId);
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
  const clientId = environmentBrowserHostClientId(environmentId);
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

  const signState = Effect.fn("RemoteBrowser.signInteractionState")(function* (
    state: PreviewRemoteInteractionState,
    cache: Map<string, { url: string; expires: number }>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const downloads = yield* Effect.forEach(state.downloads, (download) =>
      Effect.gen(function* () {
        if (download.status !== "ready" || !download.attachmentId) return download;
        const cached = cache.get(download.attachmentId);
        if (cached && cached.expires > now) return { ...download, url: cached.url };
        const signed = yield* signArtifact({
          id: download.attachmentId,
          path: "",
          mimeType: "application/octet-stream",
          sizeBytes: download.sizeBytes ?? 0,
          createdAt: "",
          downloadName: download.name,
        });
        cache.set(download.attachmentId, { url: signed.url, expires: now + 30 * 60 * 1000 });
        return { ...download, url: signed.url };
      }).pipe(
        Effect.catch(() =>
          Effect.succeed({
            ...download,
            status: "failed" as const,
            error: "The retained download is no longer available.",
          }),
        ),
      ),
    );
    return { ...state, downloads };
  });

  return {
    command,
    interact: Effect.fn("RemoteBrowser.interact")(function* (input) {
      const authorize = Effect.gen(function* () {
        const projection = yield* checkAvailable(input.threadId);
        if (
          projection.runs.some((run) =>
            ["preparing", "starting", "running"].includes(run.status),
          ) &&
          projection.thread.browserTakeover?.status !== "active"
        )
          return yield* new PreviewRemoteError({
            detail: "Take browser control before interacting while the agent is working.",
          });
      });
      yield* authorize;
      yield* broker
        .selectHostForThread({ environmentId, threadId: input.threadId, clientId })
        .pipe(Effect.mapError((error) => new PreviewRemoteError({ detail: error.message })));
      yield* operation(() => runtime.interact(input, () => Effect.runPromise(authorize)));
    }),
    interactions: (input) =>
      Stream.unwrap(
        Effect.sync(() => {
          const cache = new Map<string, { url: string; expires: number }>();
          return Stream.callback<PreviewRemoteInteractionEvent, PreviewRemoteError>(
            (queue) =>
              Effect.gen(function* () {
                yield* checkAvailable(input.threadId);
                yield* Effect.acquireRelease(
                  Effect.sync(() => {
                    const queues = interactionQueues.get(input.threadId) ?? new Set();
                    queues.add(queue);
                    interactionQueues.set(input.threadId, queues);
                  }),
                  () =>
                    Effect.sync(() => {
                      const queues = interactionQueues.get(input.threadId);
                      queues?.delete(queue);
                      if (!queues?.size) interactionQueues.delete(input.threadId);
                    }),
                );
                yield* Effect.acquireRelease(
                  operation(() =>
                    runtime.subscribeInteractions(input.threadId, (event) => {
                      Queue.offerUnsafe(queue, event);
                    }),
                  ),
                  (unsubscribe) => Effect.promise(unsubscribe),
                );
                yield* checkAvailable(input.threadId);
              }).pipe(Effect.catch((error) => Queue.fail(queue, error))),
            { bufferSize: 1, strategy: "sliding" },
          ).pipe(
            Stream.mapEffect((event) =>
              Effect.gen(function* () {
                const tabs = yield* Effect.forEach(event.tabs, (tab) => signState(tab, cache));
                const retained = new Set(
                  tabs.flatMap((tab) =>
                    tab.downloads.flatMap((d) => (d.attachmentId ? [d.attachmentId] : [])),
                  ),
                );
                for (const id of cache.keys()) if (!retained.has(id)) cache.delete(id);
                return { ...event, tabs };
              }),
            ),
          );
        }),
      ),
    subscribeSurface: Effect.fn("RemoteBrowser.subscribeSurface")(function* (input, sink) {
      yield* checkAvailable(input.threadId);
      yield* Effect.acquireRelease(
        operation(() =>
          runtime.subscribeSurface(input.threadId, input.tabId, input.viewport, sink),
        ),
        (unsubscribe) => Effect.promise(unsubscribe),
      );
      yield* checkAvailable(input.threadId);
    }),
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
    const events = yield* EventStoreV2;
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
    let afterSequence = yield* events.latestSequence();
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
          resource: {
            _tag: "attachment",
            attachmentId: capture.id,
            mimeType: capture.mimeType,
            ...(capture.downloadName ? { fileName: capture.downloadName } : {}),
          },
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
).pipe(Layer.provide(eventStoreLayer));
