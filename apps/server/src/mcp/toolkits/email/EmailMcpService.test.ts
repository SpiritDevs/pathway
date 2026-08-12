import * as NodeServices from "@effect/platform-node/NodeServices";
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
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { EmailStore, type CapturedEmailMessageInput } from "../../../email/EmailStore.ts";
import * as EmailStoreLive from "../../../email/EmailStore.ts";
import { EmailWaitStore } from "../../../email/EmailWaitStore.ts";
import * as EmailWaitStoreLive from "../../../email/EmailWaitStore.ts";
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
    retention: { maxMessages: null, maxAgeDays: null },
    toastMuted: false,
    twoFactorCodeRegex: null,
  },
  {
    projectId: projectB,
    mailSlug: EmailMailSlug.make("project-b"),
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
          const notifications = yield* service.subscribeTaskNotifications;
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

            const task = yield* service.getTask(taskId);
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
});
