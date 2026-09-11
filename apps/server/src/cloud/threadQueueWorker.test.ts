// @effect-diagnostics anyUnknownInErrorContext:off
import { describe, expect, it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId, ProviderInstanceId, RunId } from "@spiritdevs/contracts";
import type { ThreadQueueAcceptance, ThreadQueueHead } from "@spiritdevs/contracts/threadQueue";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { CompanyId } from "@spiritdevs/contracts/company";
import type { OrchestrationV2Command } from "@spiritdevs/contracts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as ServerConfig from "../config.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";

import {
  makeLocalThreadQueueExecutor,
  threadQueueDeliveryCommandId,
  threadQueueDispatchMode,
  persistThreadQueueAttachment,
  deliverThreadQueueHead,
  runThreadQueueWorker,
  type ThreadQueueBackend,
  type ThreadQueueExecutor,
} from "./threadQueueWorker.ts";

class ThreadQueueTestError extends Error {
  readonly _tag = "ThreadQueueTestError";
}

const head: ThreadQueueHead = {
  threadId: "queued-thread",
  commandId: "queued-command",
  revision: 1,
};
const accepted: ThreadQueueAcceptance = {
  ...head,
  state: "queued",
  localProjectId: null,
  issuedByMembershipId: "member",
  attachments: [],
  submission: {
    kind: "launch",
    input: {
      commandId: CommandId.make(head.commandId),
      threadId: ThreadId.make(head.threadId),
      projectId: null,
      title: "A queued thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: {
        messageId: MessageId.make("queued-message"),
        text: "Keep this prompt",
        attachments: [],
      },
    },
  },
};

function backendOf(overrides: Partial<ThreadQueueBackend> = {}): ThreadQueueBackend {
  return {
    heads: Stream.make([head]),
    prepare: () => Effect.succeed(accepted),
    accept: () => Effect.succeed(accepted),
    acknowledge: () => Effect.void,
    reportBlocked: () => Effect.void,
    ...overrides,
  };
}

describe("durable cloud thread delivery", () => {
  it.effect("does not acknowledge until local persistence completes", () =>
    Effect.gen(function* () {
      const writing = yield* Deferred.make<void>();
      const persisted = yield* Deferred.make<void>();
      const acknowledged: ThreadQueueHead[] = [];
      const backend = backendOf({
        acknowledge: (value) =>
          Effect.sync(() => {
            acknowledged.push(value);
          }),
      });
      const worker = yield* deliverThreadQueueHead(
        backend,
        {
          prepare: () =>
            Effect.succeed(
              Deferred.succeed(writing, undefined).pipe(Effect.andThen(Deferred.await(persisted))),
            ),
        },
        head,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(writing);
      expect(acknowledged).toEqual([]);
      yield* Deferred.succeed(persisted, undefined);
      yield* Fiber.join(worker);
      expect(acknowledged).toEqual([accepted]);
    }),
  );

  it.effect("does not execute when reassignment or cancellation wins acceptance", () =>
    Effect.gen(function* () {
      let executed = false;
      yield* deliverThreadQueueHead(
        backendOf({ accept: () => Effect.succeed(null) }),
        {
          prepare: () =>
            Effect.succeed(
              Effect.sync(() => {
                executed = true;
              }),
            ),
        },
        head,
      );
      expect(executed).toBe(false);
    }),
  );

  it.effect("retries the same durable identity after an acknowledgement is lost", () =>
    Effect.gen(function* () {
      const receipts = new Set<string>();
      let executions = 0;
      let acknowledgements = 0;
      const executor: ThreadQueueExecutor = {
        prepare: (value) =>
          Effect.succeed(
            Effect.sync(() => {
              expect(value.submission.input.commandId).toBe(head.commandId);
              if (!receipts.has(value.commandId)) {
                receipts.add(value.commandId);
                executions += 1;
              }
            }),
          ),
      };
      const backend = backendOf({
        acknowledge: () =>
          Effect.suspend(() => {
            acknowledgements += 1;
            return acknowledgements === 1
              ? Effect.fail(new ThreadQueueTestError("connection lost"))
              : Effect.void;
          }),
      });
      yield* deliverThreadQueueHead(backend, executor, head).pipe(Effect.exit);
      yield* deliverThreadQueueHead(backend, executor, head);
      expect(acknowledgements).toBe(2);
      expect(executions).toBe(1);
    }),
  );

  it.effect("retains the environment fence after an uncertain local write", () =>
    Effect.gen(function* () {
      const blocked: string[] = [];
      let acknowledged = false;
      yield* deliverThreadQueueHead(
        backendOf({
          reportBlocked: (_, error, release) =>
            Effect.sync(() => {
              expect(error).toContain("disk");
              blocked.push(release);
            }),
          acknowledge: () =>
            Effect.sync(() => {
              acknowledged = true;
            }),
        }),
        {
          prepare: () =>
            Effect.succeed(Effect.fail(new ThreadQueueTestError("disk failure after receipt"))),
        },
        head,
      );
      expect(blocked).toEqual(["delivery"]);
      expect(acknowledged).toBe(false);
    }),
  );

  it.effect("reports preparation failures without accepting or releasing ownership", () =>
    Effect.gen(function* () {
      const phases: string[] = [];
      let accepts = 0;
      const backend = backendOf({
        accept: () =>
          Effect.sync(() => {
            accepts += 1;
            return accepted;
          }),
        reportBlocked: (_, __, phase) =>
          Effect.sync(() => {
            phases.push(phase);
          }),
      });
      yield* deliverThreadQueueHead(
        backend,
        { prepare: () => Effect.fail(new ThreadQueueTestError("Provider is not installed")) },
        head,
      );
      yield* deliverThreadQueueHead(
        { ...backend, prepare: () => Effect.succeed({ ...accepted, state: "accepted" }) },
        { prepare: () => Effect.fail(new ThreadQueueTestError("Cannot read prior receipt")) },
        head,
      );
      expect(phases).toEqual(["preflight", "delivery"]);
      expect(accepts).toBe(0);
    }),
  );

  it.effect(
    "leaves busy threads unaccepted and resumes on a local completion without blocking other threads",
    () =>
      Effect.gen(function* () {
        const updates = yield* Queue.unbounded<string>();
        const subscribed = yield* Deferred.make<void>();
        const deferred = yield* Deferred.make<void>();
        const otherDelivered = yield* Deferred.make<void>();
        const resumed = yield* Deferred.make<void>();
        let busy = true;
        const persisted: string[] = [];
        const other = { ...head, threadId: "other-thread", commandId: "other-command" };
        const worker = yield* runThreadQueueWorker(
          backendOf({
            heads: Stream.concat(Stream.make([head, other]), Stream.never),
            prepare: (value) => Effect.succeed({ ...accepted, ...value }),
            accept: (value) => Effect.succeed({ ...accepted, ...value }),
            acknowledge: (value) =>
              value.threadId === head.threadId
                ? Deferred.succeed(resumed, undefined).pipe(Effect.asVoid)
                : Deferred.succeed(otherDelivered, undefined).pipe(Effect.asVoid),
          }),
          {
            wakeups: Stream.unwrap(
              Deferred.succeed(subscribed, undefined).pipe(Effect.as(Stream.fromQueue(updates))),
            ),
            prepare: (value) =>
              Effect.gen(function* () {
                yield* Deferred.await(subscribed);
                if (value.threadId === head.threadId && busy) {
                  yield* Deferred.succeed(deferred, undefined);
                  return null;
                }
                return Effect.sync(() => {
                  persisted.push(value.commandId);
                });
              }),
          },
        ).pipe(Effect.forkChild);
        yield* Deferred.await(deferred);
        yield* Deferred.await(otherDelivered);
        expect(persisted).toEqual([other.commandId]);
        busy = false;
        yield* Queue.offer(updates, head.threadId);
        yield* Deferred.await(resumed);
        expect(persisted).toEqual([other.commandId, head.commandId]);
        yield* Fiber.interrupt(worker);
      }),
  );

  it.effect("persists the preceding message before processing the next subscribed head", () =>
    Effect.gen(function* () {
      const next = { ...head, commandId: "second-command" };
      const events: string[] = [];
      yield* runThreadQueueWorker(
        backendOf({
          heads: Stream.make([head], [next]),
          prepare: (value) => Effect.succeed({ ...accepted, ...value }),
          accept: (value) =>
            Effect.sync(() => {
              events.push(`accept:${value.commandId}`);
              return { ...accepted, ...value };
            }),
          acknowledge: (value) =>
            Effect.sync(() => {
              events.push(`ack:${value.commandId}`);
            }),
        }),
        {
          prepare: (value) =>
            Effect.succeed(
              Effect.sync(() => {
                events.push(`persist:${value.commandId}`);
              }),
            ),
        },
      );
      expect(events).toEqual([
        "accept:queued-command",
        "persist:queued-command",
        "ack:queued-command",
        "accept:second-command",
        "persist:second-command",
        "ack:second-command",
      ]);
    }),
  );
});

const attachmentLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "pathway-thread-queue-",
}).pipe(Layer.provideMerge(NodeServices.layer));

describe("queued attachment durability", () => {
  it.effect("downloads once into a stable thread-owned file and reuses it after restart", () =>
    Effect.gen(function* () {
      let downloads = 0;
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          downloads += 1;
          return HttpClientResponse.fromWeb(request, new Response("saved bytes"));
        }),
      );
      const source = {
        attachment: {
          id: "cloud-attachment",
          type: "file",
          name: "note.txt",
          mimeType: "text/plain",
          sizeBytes: 11,
        },
        url: "https://cloud.example/attachment",
      };
      const first = yield* persistThreadQueueAttachment(head.threadId, source).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      const retry = yield* persistThreadQueueAttachment(head.threadId, source).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(retry).toEqual(first);
      expect(first.id).toMatch(/^queued-thread-/);
      expect(downloads).toBe(1);
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: first,
      });
      expect(path).not.toBeNull();
      expect(yield* fs.readFileString(path!)).toBe("saved bytes");
    }).pipe(Effect.provide(attachmentLayer)),
  );

  it.effect("rejects incomplete downloads and leaves no file that can be accepted", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response("short"))),
      );
      const source = {
        attachment: {
          id: "cloud-attachment",
          type: "file",
          name: "note.txt",
          mimeType: "text/plain",
          sizeBytes: 11,
        },
        url: "https://cloud.example/attachment",
      };
      const failure = yield* persistThreadQueueAttachment(head.threadId, source).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );
      expect(String(failure)).toContain("incomplete");
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      expect(yield* fs.readDirectory(config.attachmentsDir)).toEqual([]);
    }).pipe(Effect.provide(attachmentLayer)),
  );
});

it("keeps transport retries on the same command and fences explicitly authorized rejected retries", () => {
  expect(threadQueueDeliveryCommandId(head)).toBe(head.commandId);
  expect(threadQueueDeliveryCommandId({ ...head, revision: 2 })).toBe(head.commandId);
  expect(threadQueueDeliveryCommandId({ ...head, revision: 2, deliveryAttempt: 1 })).toBe(
    `${head.commandId}:queue-retry:1`,
  );
});

it.effect("reports a rejected retry proof only after reading the durable receipt", () =>
  Effect.gen(function* () {
    const reports: Array<string | undefined> = [];
    const backend = backendOf({
      reportBlocked: (_, __, ___, rejection) =>
        Effect.sync(() => {
          reports.push(rejection);
        }),
    });
    yield* deliverThreadQueueHead(
      backend,
      {
        prepare: () => Effect.succeed(Effect.fail(new ThreadQueueTestError("dispatch rejected"))),
        rejectionProof: () => Effect.succeed("command"),
      },
      head,
    );
    yield* deliverThreadQueueHead(
      backend,
      {
        prepare: () =>
          Effect.succeed(Effect.fail(new ThreadQueueTestError("connection lost after dispatch"))),
        rejectionProof: () => Effect.fail(new ThreadQueueTestError("receipt unavailable")),
      },
      head,
    );
    expect(reports).toEqual(["command", undefined]);
  }),
);

it("preserves explicit steering and restart targets while ordering ordinary messages", () => {
  const targetRunId = RunId.make("active-run");
  expect(threadQueueDispatchMode({ type: "steer_active", targetRunId })).toEqual({
    type: "steer_active",
    targetRunId,
  });
  expect(threadQueueDispatchMode({ type: "restart_active", targetRunId })).toEqual({
    type: "restart_active",
    targetRunId,
  });
  expect(threadQueueDispatchMode({ type: "start_immediately" })).toEqual({
    type: "queue_after_active",
  });
});

it.effect("dispatches queued checkout metadata atomically with the follow-up", () =>
  Effect.gen(function* () {
    const commands: OrchestrationV2Command[] = [];
    const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
    const submission: ThreadQueueAcceptance = {
      ...accepted,
      submission: {
        kind: "message",
        branch: "release-review",
        input: {
          type: "message.dispatch",
          commandId: CommandId.make(head.commandId),
          threadId: ThreadId.make(head.threadId),
          messageId: MessageId.make("follow-up"),
          text: "Review this checkout",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          modelSelection: selection,
          dispatchMode: { type: "queue_after_active" },
        },
      },
    };
    const executor = yield* makeLocalThreadQueueExecutor("company" as CompanyId).pipe(
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        streamDomainEvents: Stream.empty,
        getThreadProjection: () =>
          Effect.succeed({ thread: { modelSelection: selection }, runs: [] }),
        dispatch: (command: OrchestrationV2Command) =>
          Effect.sync(() => {
            commands.push(command);
          }),
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Effect.provideService(
        ThreadLaunch.ThreadLaunchService,
        {} as ThreadLaunch.ThreadLaunchService["Service"],
      ),
      Effect.provideService(Receipts.CommandReceiptStoreV2, {
        getByCommandId: () => Effect.succeed(Option.none()),
      } as unknown as Receipts.CommandReceiptStoreV2["Service"]),
      Effect.provideService(
        ProjectService.ProjectService,
        {} as ProjectService.ProjectService["Service"],
      ),
      Effect.provideService(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed([
          {
            ...selection,
            enabled: true,
            installed: true,
            availability: "available",
            auth: { status: "authenticated" },
          },
        ]),
      } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
      Effect.provideService(FileSystem.FileSystem, {} as FileSystem.FileSystem),
      Effect.provideService(ServerConfig.ServerConfig, {} as ServerConfig.ServerConfig["Service"]),
      Effect.provideService(HttpClient.HttpClient, {} as HttpClient.HttpClient),
    );
    const dispatch = yield* executor.prepare(submission);
    expect(commands).toEqual([]);
    expect(dispatch).not.toBeNull();
    if (dispatch) yield* dispatch;
    expect(commands.map((command) => command.type)).toEqual(["message.dispatch"]);
    expect(commands[0]).toMatchObject({
      branch: "release-review",
      commandId: "queued-command",
    });
  }),
);
