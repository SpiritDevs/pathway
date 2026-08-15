import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EmailMessageId,
  EmailTriggerRuleId,
  ProjectId,
  ProviderInstanceId,
  type CapturedEmailMessage,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { EmailTriggerService, layer } from "./EmailTriggerService.ts";

const projectId = ProjectId.make("project:email-trigger-test");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const project = {
  id: projectId,
  title: "Email project",
  workspaceRoot: "/email-project",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  scripts: [],
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
  deletedAt: null,
};

const deliverability = {
  version: 1,
  checks: [],
  metrics: {
    subjectLength: 0,
    imageCount: 0,
    visibleTextCharacters: 0,
    imageToTextRatio: 0,
    trackingPixelCount: 0,
  },
  htmlCompatibilityWarnings: [],
} as const;

function message(id: string, overrides: Partial<CapturedEmailMessage> = {}): CapturedEmailMessage {
  return {
    id: EmailMessageId.make(id),
    attribution: {
      projectId,
      mailSlug: "email-project" as CapturedEmailMessage["attribution"]["mailSlug"],
      matchedBy: "recipient-domain",
      matchedValue: "agent@email-project.test",
    },
    envelope: {
      mailFrom: "sender@example.com",
      rcptTo: ["agent@email-project.test"],
      authUsername: null,
      helo: "localhost",
      remoteAddress: "127.0.0.1",
    },
    parsedHeaders: {
      subject: "Verification code",
      messageId: `${id}@example.com`,
      date: "2026-08-12T00:00:00.000Z",
      from: [{ address: "sender@example.com", name: "Sender" }],
      to: [{ address: "agent@email-project.test", name: null }],
      cc: [],
      bcc: [],
      replyTo: [],
      headers: [],
    },
    textBody: "Use ABC123 to continue.",
    htmlBody: null,
    attachments: [],
    smtpTransactionLog: [],
    timings: {
      connectedAt: "2026-08-12T00:00:00.000Z",
      messageReceivedAt: "2026-08-12T00:00:00.000Z",
      parsedAt: "2026-08-12T00:00:00.000Z",
      storedAt: "2026-08-12T00:00:00.000Z",
      parseDurationMs: 1,
      totalDurationMs: 2,
    },
    sizeBytes: 100,
    isRead: false,
    detectedCode: "ABC123",
    deliverability,
    ...overrides,
  };
}

function makeTestLayer(launches: Ref.Ref<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>) {
  const threadLaunch = Layer.succeed(
    ThreadLaunch.ThreadLaunchService,
    ThreadLaunch.ThreadLaunchService.of({
      launch: (input) =>
        Ref.update(launches, (current) => [...current, input]).pipe(
          Effect.as({
            threadId: input.threadId!,
            projection: {} as ThreadLaunch.ThreadLaunchResult["projection"],
            resumed: false,
          }),
        ),
    }),
  );
  const projects = Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.succeed(Option.some(project)),
  });
  const dependencies = Layer.mergeAll(
    SqlitePersistenceMemory,
    NodeCrypto.layer,
    threadLaunch,
    projects,
    ServerSettings.layerTest({ textGenerationModelSelection: modelSelection }),
    TestClock.layer(),
  );
  return layer.pipe(Layer.provide(dependencies));
}

const withTriggers = <A, E>(
  use: (
    triggers: EmailTriggerService["Service"],
    launches: Ref.Ref<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const launches = yield* Ref.make<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>([]);
    return yield* Effect.gen(function* () {
      const triggers = yield* EmailTriggerService;
      return yield* use(triggers, launches);
    }).pipe(Effect.provide(makeTestLayer(launches)), Effect.scoped);
  });

const createRule = (
  triggers: EmailTriggerService["Service"],
  overrides: Partial<Parameters<typeof triggers.upsertRule>[0]> = {},
) =>
  triggers.upsertRule({
    id: EmailTriggerRuleId.make("rule:verification"),
    projectId,
    name: "Verification mail",
    enabled: true,
    matcher: { sender: "sender@example.com", subject: "verification", recipient: null },
    promptTemplate: "Handle {{messageId}}",
    maxTriggersPerHour: 10,
    ...overrides,
  });

it.effect("fires one new orchestration thread once per matching captured message", () =>
  withTriggers((triggers, launches) =>
    Effect.gen(function* () {
      yield* createRule(triggers);
      const captured = message("message:once");

      const first = yield* triggers.processMessage({ message: captured });
      const replay = yield* triggers.processMessage({ message: captured });
      const unrelated = yield* triggers.processMessage({
        message: message("message:unrelated", {
          parsedHeaders: { ...captured.parsedHeaders, subject: "A receipt" },
        }),
      });

      assert.strictEqual(first[0]?.type, "launched");
      assert.deepStrictEqual(replay, []);
      assert.deepStrictEqual(unrelated, []);
      assert.strictEqual((yield* Ref.get(launches)).length, 1);
      const log = yield* triggers.listFirings({ projectId });
      assert.strictEqual(log.firings.length, 1);
      assert.strictEqual(log.firings[0]?.messageId, captured.id);
    }),
  ),
);

it.effect("enforces each rule's persisted hourly trigger cap", () =>
  withTriggers((triggers, launches) =>
    Effect.gen(function* () {
      yield* createRule(triggers, { maxTriggersPerHour: 1 });

      const first = yield* triggers.processMessage({ message: message("message:cap-1") });
      const capped = yield* triggers.processMessage({ message: message("message:cap-2") });
      assert.strictEqual(first[0]?.type, "launched");
      assert.strictEqual(capped[0]?.type, "rate-limited");
      assert.strictEqual((yield* Ref.get(launches)).length, 1);
      assert.strictEqual(
        (yield* triggers.listRules({ projectId })).rules[0]?.rateLimitWindowStartedAt,
        "2026-08-12T00:00:00.000Z",
      );

      const afterOneHour = message("message:cap-3", {
        timings: {
          ...message("message:cap-timing").timings,
          storedAt: "2026-08-12T01:00:00.000Z",
        },
      });
      const nextWindow = yield* triggers.processMessage({ message: afterOneHour });
      assert.strictEqual(nextWindow[0]?.type, "launched");
      assert.strictEqual((yield* Ref.get(launches)).length, 2);
    }),
  ),
);

it.effect("auto-disables a rule when its own thread produces matching mail", () =>
  withTriggers((triggers, launches) =>
    Effect.gen(function* () {
      yield* createRule(triggers);
      const first = yield* triggers.processMessage({ message: message("message:loop-source") });
      assert.strictEqual(first[0]?.type, "launched");
      if (first[0]?.type !== "launched") return;

      const noticeFiber = yield* Stream.runHead(triggers.notices).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const loopMessage = message("message:loop-result");
      const loop = yield* triggers.processMessage({
        message: loopMessage,
        originatingThreadId: first[0].firing.threadId,
      });
      const notice = yield* Fiber.join(noticeFiber);

      assert.strictEqual(loop[0]?.type, "loop-disabled");
      assert.strictEqual((yield* Ref.get(launches)).length, 1);
      const rules = yield* triggers.listRules({ projectId });
      assert.strictEqual(rules.rules[0]?.enabled, false);
      assert.strictEqual(rules.rules[0]?.autoDisabledAt !== null, true);
      const log = yield* triggers.listFirings({ projectId });
      assert.strictEqual(log.firings[0]?.status, "loop-detected");
      assert.strictEqual(log.firings[0]?.loopMessageId, loopMessage.id);
      assert.strictEqual(Option.getOrThrow(notice)._tag, "EmailTriggerRuleAutoDisabled");
    }),
  ),
);

it.effect("renders every documented prompt variable before dispatch", () =>
  withTriggers((triggers, launches) =>
    Effect.gen(function* () {
      yield* createRule(triggers, {
        promptTemplate:
          "sender={{sender}}\nsubject={{ subject }}\nbody={{body}}\ncode={{code}}\nalias={{detectedCode}}\nid={{messageId}}",
      });
      const captured = message("message:variables");
      yield* triggers.processMessage({ message: captured });

      assert.strictEqual(
        (yield* Ref.get(launches))[0]?.initialMessage?.text,
        [
          "sender=sender@example.com",
          "subject=Verification code",
          "body=Use ABC123 to continue.",
          "code=ABC123",
          "alias=ABC123",
          `id=${captured.id}`,
        ].join("\n"),
      );
    }),
  ),
);
