import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  Client,
  PROTOCOL_VERSION_META_KEY,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  EmailMailSlug,
  EmailMessageId,
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type EmailProjectSettings,
  EmailMcpTaskState,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { EmailStore, type CapturedEmailMessageInput } from "../../../email/EmailStore.ts";
import * as EmailStoreLive from "../../../email/EmailStore.ts";
import { EmailWaitStore } from "../../../email/EmailWaitStore.ts";
import * as EmailWaitStoreLive from "../../../email/EmailWaitStore.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import {
  emailMcpListCursor,
  EmailMcpProjectScopeTest,
  EmailMcpService,
  layer as EmailMcpServiceLayer,
} from "./EmailMcpService.ts";

const projectA = ProjectId.make("project:email:a");
const projectB = ProjectId.make("project:email:b");
const threadA = ThreadId.make("thread:email:a");
const threadB = ThreadId.make("thread:email:b");
const instanceId = ProviderInstanceId.make("codex");

const projectSettings: ReadonlyArray<EmailProjectSettings> = [
  {
    projectId: projectA,
    mailSlug: EmailMailSlug.make("project-a"),
    capturePassword: null,
    retention: { maxMessages: null, maxAgeDays: null },
    toastMuted: false,
    twoFactorCodeRegex: null,
  },
  {
    projectId: projectB,
    mailSlug: EmailMailSlug.make("project-b"),
    capturePassword: null,
    retention: { maxMessages: null, maxAgeDays: null },
    toastMuted: false,
    twoFactorCodeRegex: null,
  },
];

const invocation = (threadId: ThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:email-test"),
  threadId,
  providerSessionId: `provider-session:${threadId}`,
  providerInstanceId: instanceId,
  providerDriverKind: ProviderDriverKind.make("codex"),
  capabilities: new Set(["email"]),
  issuedAt: 1,
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const TaskCreateResponse = Schema.Struct({
  result: Schema.Struct({
    resultType: Schema.Literal("task"),
    task: EmailMcpTaskState,
  }),
});
const TaskStateResponse = Schema.Struct({
  result: Schema.Struct({ resultType: Schema.Literal("complete"), task: EmailMcpTaskState }),
});
const ErrorResponse = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Number,
    data: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
});
const ToolResponse = Schema.Struct({ result: Schema.Record(Schema.String, Schema.Unknown) });
const SseNotification = Schema.Struct({
  method: Schema.String,
  params: Schema.Record(Schema.String, Schema.Unknown),
});
const decodeTaskCreateResponse = Schema.decodeUnknownEffect(TaskCreateResponse);
const decodeTaskStateResponse = Schema.decodeUnknownEffect(TaskStateResponse);
const decodeErrorResponse = Schema.decodeUnknownEffect(ErrorResponse);
const decodeToolResponse = Schema.decodeUnknownEffect(ToolResponse);
const decodeSseNotification = Schema.decodeUnknownSync(Schema.fromJsonString(SseNotification));

const v2Request = (
  method: string,
  params: Record<string, unknown>,
  tasks: boolean,
  name?: string,
) =>
  new Request("http://pathway.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": McpHttpServer.MCP_PROTOCOL_VERSION,
      "mcp-method": method,
      ...(name === undefined ? {} : { "mcp-name": name }),
    },
    body: encodeJson({
      jsonrpc: "2.0",
      id: `${method}:test`,
      method,
      params: {
        ...params,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: McpHttpServer.MCP_PROTOCOL_VERSION,
          [CLIENT_INFO_META_KEY]: { name: "email-extension-test", version: "1.0.0" },
          [CLIENT_CAPABILITIES_META_KEY]: tasks
            ? { extensions: { [McpHttpServer.MCP_TASKS_EXTENSION]: {} } }
            : {},
        },
      },
    }),
  });

const makeSseNotificationReader = (reader: {
  readonly read: () => Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
}) => {
  const decoder = new TextDecoder();
  let buffered = "";
  return async () => {
    while (!buffered.includes("\n\n")) {
      const next = await reader.read();
      if (next.done) throw new Error("SSE stream closed before a notification arrived.");
      if (next.value !== undefined) buffered += decoder.decode(next.value, { stream: true });
    }
    const boundary = buffered.indexOf("\n\n");
    const frame = buffered.slice(0, boundary);
    buffered = buffered.slice(boundary + 2);
    const data = frame
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length);
    if (data === undefined) throw new Error("SSE frame did not contain data.");
    return decodeSseNotification(data);
  };
};

const fixture = (
  id: string,
  projectId: ProjectId,
  mailSlug: string,
): CapturedEmailMessageInput => ({
  id: EmailMessageId.make(id),
  attribution: {
    projectId,
    mailSlug: EmailMailSlug.make(mailSlug),
    matchedBy: "recipient-domain",
    matchedValue: `login@${mailSlug}.test`,
  },
  envelope: {
    mailFrom: "auth@example.test",
    rcptTo: [`login@${mailSlug}.test`],
    authUsername: null,
    helo: "localhost",
    remoteAddress: "127.0.0.1",
  },
  parsedHeaders: {
    subject: "Your verification code",
    messageId: `<${id}@example.test>`,
    date: IsoDateTime.make("2026-08-12T12:00:00.000Z"),
    from: [{ address: "auth@example.test", name: "Auth" }],
    to: [{ address: `login@${mailSlug}.test`, name: null }],
    cc: [],
    bcc: [],
    replyTo: [],
    headers: [{ name: "subject", value: "Your verification code" }],
  },
  textBody: "Your verification code is 482913.",
  htmlBody: "<p>Your verification code is <strong>482913</strong>.</p>",
  attachments: [],
  smtpTransactionLog: [],
  timings: {
    connectedAt: IsoDateTime.make("2026-08-12T12:00:00.000Z"),
    messageReceivedAt: IsoDateTime.make("2026-08-12T12:00:00.010Z"),
    parsedAt: IsoDateTime.make("2026-08-12T12:00:00.020Z"),
    storedAt: IsoDateTime.make("2026-08-12T12:00:00.030Z"),
    parseDurationMs: 10,
    totalDurationMs: 30,
  },
  sizeBytes: 256,
  isRead: false,
  detectedCode: "482913",
});

const testLayer = (databasePath: string) => {
  const mail = Layer.mergeAll(
    EmailStoreLive.layerAtPath(databasePath),
    EmailWaitStoreLive.layerAtPath(databasePath),
  );
  const scope = EmailMcpProjectScopeTest({
    projectByThread: new Map([
      [threadA, projectA],
      [threadB, projectB],
    ]),
    projects: projectSettings,
  });
  const service = EmailMcpServiceLayer.pipe(Layer.provide(mail), Layer.provide(scope));
  return Layer.mergeAll(mail, scope, service);
};

const withDatabase = <A, E>(
  effect: (
    databasePath: string,
  ) => Effect.Effect<A, E, EmailStore | EmailWaitStore | EmailMcpService>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-email-mcp-test-" });
      const databasePath = path.join(directory, "mail.sqlite");
      return yield* effect(databasePath).pipe(Effect.provide(testLayer(databasePath)));
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const criteria = {
  scope: { type: "project", projectId: projectA } as const,
  sender: "auth@example.test",
  subject: "verification",
  recipient: null,
};

describe("EmailMcpService", () => {
  it.effect("delivers the same fixture through task push and bounded long-poll", () =>
    withDatabase(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* EmailMcpService;
          const store = yield* EmailStore;
          const waits = yield* EmailWaitStore;

          const created = yield* service.waitFor(
            invocation(threadA),
            { sender: "auth@example.test", subject: "verification" },
            true,
          );
          expect("task" in created).toBe(true);
          if (!("task" in created)) return;
          expect(created.task.status).toBe("working");

          yield* waits.register({
            threadId: threadA,
            providerInstanceId: instanceId,
            criteria,
            delivery: "long-poll",
            timeoutMs: 120_000,
          });
          const longPollFiber = yield* service
            .waitFor(
              invocation(threadA),
              { sender: "auth@example.test", subject: "verification" },
              false,
            )
            .pipe(Effect.forkChild);
          const notifications = yield* service.subscribeTaskNotifications(invocation(threadA));
          const notificationFiber = yield* notifications.pipe(Stream.runHead, Effect.forkChild);

          const message = yield* store.capture(fixture("message:delivery", projectA, "project-a"));
          yield* waits.completeMatching(message);

          const longPoll = yield* Fiber.join(longPollFiber);
          expect("message" in longPoll && longPoll.message?.id).toBe(message.id);
          const pushed = yield* Fiber.join(notificationFiber);
          expect(Option.isSome(pushed)).toBe(true);
          if (Option.isSome(pushed)) {
            expect(pushed.value).toMatchObject({
              taskId: created.task.taskId,
              status: "completed",
              result: { id: message.id },
              error: null,
            });
          }
        }),
      ),
    ),
  );

  it.effect("resumes task and long-poll waits from mail.sqlite after restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-email-restart-test-" });
        const databasePath = path.join(directory, "mail.sqlite");

        const taskId = yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* EmailMcpService;
            const waits = yield* EmailWaitStore;
            const created = yield* service.waitFor(
              invocation(threadA),
              { subject: "verification" },
              true,
            );
            if (!("task" in created)) return yield* Effect.die("Expected a task result");
            yield* waits.register({
              threadId: threadA,
              providerInstanceId: instanceId,
              criteria: { ...criteria, sender: null },
              delivery: "long-poll",
              timeoutMs: 120_000,
            });
            return created.task.taskId;
          }).pipe(Effect.provide(testLayer(databasePath))),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* EmailStore;
            const waits = yield* EmailWaitStore;
            const service = yield* EmailMcpService;
            const message = yield* store.capture(
              fixture("message:after-restart", projectA, "project-a"),
            );
            yield* waits.completeMatching(message);

            const task = yield* service.getTask(invocation(threadA), taskId);
            expect(task).toMatchObject({ status: "completed", result: { id: message.id } });
            const resumed = yield* service.waitFor(
              invocation(threadA),
              { subject: "verification" },
              false,
            );
            expect("message" in resumed && resumed.message?.id).toBe(message.id);
          }).pipe(Effect.provide(testLayer(databasePath))),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("defaults every read tool to the calling thread's project", () =>
    withDatabase(() =>
      Effect.gen(function* () {
        const service = yield* EmailMcpService;
        const store = yield* EmailStore;
        const messageA = yield* store.capture(fixture("message:a", projectA, "project-a"));
        const messageB = yield* store.capture(fixture("message:b", projectB, "project-b"));

        const defaultList = yield* service.list(invocation(threadA), {});
        expect(defaultList.map(({ id }) => id)).toEqual([messageA.id]);
        const widened = yield* service.list(invocation(threadA), {
          project: EmailMailSlug.make("project-b"),
        });
        expect(widened.map(({ id }) => id)).toEqual([messageB.id]);
        const all = yield* service.list(invocation(threadA), { project: "all" });
        expect(new Set(all.map(({ id }) => id))).toEqual(new Set([messageA.id, messageB.id]));

        const hidden = yield* Effect.flip(
          service.get(invocation(threadA), { messageId: messageB.id }),
        );
        expect(hidden.reason).toBe("not-found");
        const explicit = yield* service.get(invocation(threadA), {
          messageId: messageB.id,
          project: EmailMailSlug.make("project-b"),
        });
        expect(explicit.id).toBe(messageB.id);

        const latest = yield* service.latestCode(invocation(threadA), undefined);
        expect(Option.getOrNull(latest)?.messageId).toBe(messageA.id);
      }),
    ),
  );

  // The list is newest-first by receivedAt while message ids are random, so the cursor has to
  // carry the sort key — a bare id cursor repeats and skips rows across pages.
  it.effect("pages the list without repeating or skipping across the cursor", () =>
    withDatabase(() =>
      Effect.gen(function* () {
        const service = yield* EmailMcpService;
        const store = yield* EmailStore;
        const capture = (id: string, receivedAt: string) => {
          const input = fixture(id, projectA, "project-a");
          return store.capture({
            ...input,
            timings: { ...input.timings, messageReceivedAt: IsoDateTime.make(receivedAt) },
          });
        };
        // Ids deliberately ordered against arrival: the newest message has the smallest id.
        const oldest = yield* capture("message:z-oldest", "2026-08-12T10:00:00.000Z");
        const middle = yield* capture("message:m-middle", "2026-08-12T11:00:00.000Z");
        const newest = yield* capture("message:a-newest", "2026-08-12T12:00:00.000Z");

        const pageOne = yield* service.list(invocation(threadA), { limit: 2 });
        expect(pageOne.map(({ id }) => id)).toEqual([newest.id, middle.id]);
        const pageTwo = yield* service.list(invocation(threadA), {
          limit: 2,
          cursor: emailMcpListCursor(pageOne.at(-1)!),
        });
        expect(pageTwo.map(({ id }) => id)).toEqual([oldest.id]);
      }),
    ),
  );

  it.effect("serves durable tasks and opted-in email notifications over MCP v2", () =>
    withDatabase(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* EmailMcpService;
          const store = yield* EmailStore;
          const waits = yield* EmailWaitStore;
          const handler = yield* McpHttpServer.makeEmailTestHandler(projectSettings);
          const caller = invocation(threadA);
          const client = yield* Effect.acquireRelease(
            Effect.promise(async () => {
              const connected = new Client(
                { name: "email-resource-test", version: "1.0.0" },
                {
                  capabilities: {},
                  versionNegotiation: {
                    mode: { pin: McpHttpServer.MCP_PROTOCOL_VERSION },
                  },
                },
              );
              await connected.connect(
                new StreamableHTTPClientTransport(new URL("http://pathway.test/mcp"), {
                  fetch: (input, init) =>
                    handler.fetch(
                      new Request(typeof input === "string" ? input : input.href, init),
                      caller,
                    ),
                }),
              );
              return connected;
            }),
            (connected) => Effect.promise(() => connected.close()).pipe(Effect.orDie),
          );
          const discovered = yield* Effect.promise(() => client.discover());
          expect(discovered.capabilities.resources?.subscribe).toBe(true);
          expect(discovered.capabilities.extensions?.[McpHttpServer.MCP_TASKS_EXTENSION]).toEqual(
            {},
          );
          const resources = yield* Effect.promise(() => client.listResources());
          expect(resources.resources.map(({ uri }) => uri)).toContain(
            "email://project/project-a/inbox",
          );
          const inbox = yield* Effect.promise(() =>
            client.readResource({ uri: "email://project/project-a/inbox" }),
          );
          expect(inbox.contents).toEqual([
            {
              uri: "email://project/project-a/inbox",
              mimeType: "application/json",
              text: "[]",
            },
          ]);

          const registrationEvents = yield* waits.subscribeRegistrations;
          const registrationFiber = yield* registrationEvents.pipe(
            Stream.filter(({ delivery }) => delivery === "long-poll"),
            Stream.runHead,
            Effect.forkChild,
          );
          const longPollFiber = yield* Effect.promise(() =>
            handler.fetch(
              v2Request(
                "tools/call",
                {
                  name: "email_wait_for",
                  arguments: { sender: "auth@example.test", subject: "verification" },
                },
                false,
                "email_wait_for",
              ),
              caller,
            ),
          ).pipe(Effect.forkChild);
          const registered = yield* Fiber.join(registrationFiber);
          expect(Option.isSome(registered)).toBe(true);
          const longPollMessage = yield* store.capture(
            fixture("message:v2-long-poll", projectA, "project-a"),
          );
          yield* waits.completeMatching(longPollMessage);
          const longPollResponse = yield* Fiber.join(longPollFiber);
          const longPoll = yield* decodeToolResponse(
            yield* Effect.promise(() => longPollResponse.json()),
          );
          expect(longPoll.result.resultType).toBe("complete");
          expect(longPoll.result.task).toBeUndefined();

          const createResponse = yield* Effect.promise(() =>
            handler.fetch(
              v2Request(
                "tools/call",
                {
                  name: "email_wait_for",
                  arguments: { sender: "auth@example.test", subject: "verification" },
                },
                true,
                "email_wait_for",
              ),
              caller,
            ),
          );
          const created = yield* decodeTaskCreateResponse(
            yield* Effect.promise(() => createResponse.json()),
          );
          expect(created.result.task.status).toBe("working");
          expect((yield* service.getTask(caller, created.result.task.taskId)).taskId).toBe(
            created.result.task.taskId,
          );

          const missingCapabilityResponse = yield* Effect.promise(() =>
            handler.fetch(
              v2Request("tasks/get", { taskId: created.result.task.taskId }, false),
              caller,
            ),
          );
          const missingCapability = yield* decodeErrorResponse(
            yield* Effect.promise(() => missingCapabilityResponse.json()),
          );
          expect(missingCapability.error.code).toBe(-32021);
          expect(missingCapability.error.data?.requiredCapabilities).toEqual({
            extensions: { [McpHttpServer.MCP_TASKS_EXTENSION]: {} },
          });

          const getResponse = yield* Effect.promise(() =>
            handler.fetch(
              v2Request("tasks/get", { taskId: created.result.task.taskId }, true),
              caller,
            ),
          );
          const got = yield* decodeTaskStateResponse(
            yield* Effect.promise(() => getResponse.json()),
          );
          expect(got.result.task.status).toBe("working");

          const listenResponse = yield* Effect.promise(() =>
            handler.fetch(
              v2Request(
                "subscriptions/listen",
                {
                  notifications: {
                    [McpHttpServer.MCP_TASKS_EXTENSION]: true,
                    resourceSubscriptions: ["email://project/project-a/inbox"],
                  },
                },
                true,
              ),
              caller,
            ),
          );
          const reader = listenResponse.body!.getReader();
          const readNotification = makeSseNotificationReader(reader);
          const acknowledged = yield* Effect.promise(readNotification);
          expect(acknowledged.method).toBe("notifications/subscriptions/acknowledged");

          const message = yield* store.capture(fixture("message:v2-task", projectA, "project-a"));
          yield* waits.completeMatching(message);
          const first = yield* Effect.promise(readNotification);
          const second = yield* Effect.promise(readNotification);
          expect(new Set([first.method, second.method])).toEqual(
            new Set(["notifications/resources/updated", "notifications/tasks"]),
          );
          const taskNotification = first.method === "notifications/tasks" ? first : second;
          expect(taskNotification.params).toMatchObject({
            taskId: created.result.task.taskId,
            status: "completed",
            result: { id: message.id },
          });

          const completedResponse = yield* Effect.promise(() =>
            handler.fetch(
              v2Request("tasks/get", { taskId: created.result.task.taskId }, true),
              caller,
            ),
          );
          const completed = yield* decodeTaskStateResponse(
            yield* Effect.promise(() => completedResponse.json()),
          );
          expect(completed.result.task.status).toBe("completed");
          yield* Effect.promise(() => reader.cancel());

          const cancelCreateResponse = yield* Effect.promise(() =>
            handler.fetch(
              v2Request(
                "tools/call",
                { name: "email_wait_for", arguments: { subject: "never-arrives" } },
                true,
                "email_wait_for",
              ),
              caller,
            ),
          );
          const cancelCreated = yield* decodeTaskCreateResponse(
            yield* Effect.promise(() => cancelCreateResponse.json()),
          );
          const cancelResponse = yield* Effect.promise(() =>
            handler.fetch(
              v2Request("tasks/cancel", { taskId: cancelCreated.result.task.taskId }, true),
              caller,
            ),
          );
          const cancelled = yield* decodeTaskStateResponse(
            yield* Effect.promise(() => cancelResponse.json()),
          );
          expect(cancelled.result.task.status).toBe("cancelled");

          const updateResponse = yield* Effect.promise(() =>
            handler.fetch(
              v2Request(
                "tasks/update",
                { taskId: cancelCreated.result.task.taskId, inputResponses: {} },
                true,
              ),
              caller,
            ),
          );
          const updated = yield* decodeTaskStateResponse(
            yield* Effect.promise(() => updateResponse.json()),
          );
          expect(updated.result.task.status).toBe("cancelled");
        }),
      ),
    ),
  );
});
