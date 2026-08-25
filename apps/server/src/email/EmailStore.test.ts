import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EmailMailSlug,
  EmailMessageId,
  ProjectId,
  type EmailProjectAttribution,
} from "@spiritdevs/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeEmailStore, type CapturedEmailMessageInput } from "./EmailStore.ts";

const projectAttribution = (project: "one" | "two"): EmailProjectAttribution => ({
  projectId: ProjectId.make(`project-${project}`),
  mailSlug: EmailMailSlug.make(`project-${project}`),
  matchedBy: "recipient-domain",
  matchedValue: `mail@project-${project}.test`,
});

const unassignedAttribution: EmailProjectAttribution = {
  projectId: null,
  mailSlug: null,
  matchedBy: "unassigned",
  matchedValue: null,
};

const capturedMessage = (input: {
  readonly id: string;
  readonly attribution: EmailProjectAttribution;
  readonly receivedAt: string;
  readonly latencyMs: number;
  readonly sender: string;
  readonly recipients: ReadonlyArray<string>;
}): CapturedEmailMessageInput => ({
  id: EmailMessageId.make(input.id),
  attribution: input.attribution,
  envelope: {
    mailFrom: input.sender,
    rcptTo: [...input.recipients],
    authUsername: null,
    helo: "localhost",
    remoteAddress: "127.0.0.1",
  },
  parsedHeaders: {
    subject: `Captured ${input.id}`,
    messageId: `${input.id}@example.test`,
    date: input.receivedAt,
    from: [{ address: input.sender, name: null }],
    to: input.recipients.map((address) => ({ address, name: null })),
    cc: [],
    bcc: [],
    replyTo: [],
    headers: [
      { name: "From", value: input.sender },
      { name: "Subject", value: `Captured ${input.id}` },
    ],
  },
  textBody: `Body for ${input.id}`,
  htmlBody: null,
  attachments: [],
  smtpTransactionLog: [],
  timings: {
    connectedAt: input.receivedAt,
    messageReceivedAt: input.receivedAt,
    parsedAt: input.receivedAt,
    storedAt: input.receivedAt,
    parseDurationMs: 0,
    totalDurationMs: input.latencyMs,
  },
  sizeBytes: 256,
  isRead: false,
  detectedCode: null,
});

const withStore = <A, E, R>(
  use: (store: Effect.Success<ReturnType<typeof makeEmailStore>>) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-mail-store-" });
      const store = yield* makeEmailStore(path.join(directory, "mail.sqlite"));
      return yield* use(store);
    }),
  ).pipe(Effect.provide(NodeServices.layer));

it.effect("computes deliverability before capture and reads the stored result back unchanged", () =>
  withStore((store) =>
    Effect.gen(function* () {
      const stored = yield* store.capture(
        capturedMessage({
          id: "message-1",
          attribution: projectAttribution("one"),
          receivedAt: "2026-08-12T10:05:00.000Z",
          latencyMs: 125,
          sender: "sender@example.com",
          recipients: ["dev@project-one.test"],
        }),
      );
      const reloaded = yield* store.getMessage(stored.id);

      expect(stored.deliverability.checks.find((check) => check.id === "dkim")?.status).toBe(
        "warning",
      );
      expect(reloaded?.deliverability).toStrictEqual(stored.deliverability);
    }),
  ),
);

it.effect("lists one logical project across its physical connection ids", () =>
  withStore((store) =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        [
          capturedMessage({
            id: "message-1",
            attribution: projectAttribution("one"),
            receivedAt: "2026-08-12T10:05:00.000Z",
            latencyMs: 100,
            sender: "one@example.com",
            recipients: ["dev@project-one.test"],
          }),
          capturedMessage({
            id: "message-2",
            attribution: projectAttribution("two"),
            receivedAt: "2026-08-12T10:10:00.000Z",
            latencyMs: 100,
            sender: "two@example.com",
            recipients: ["dev@project-two.test"],
          }),
          capturedMessage({
            id: "message-unassigned",
            attribution: unassignedAttribution,
            receivedAt: "2026-08-12T10:15:00.000Z",
            latencyMs: 100,
            sender: "other@example.com",
            recipients: ["dev@example.com"],
          }),
        ],
        store.capture,
        { concurrency: 1 },
      );

      const result = yield* store.list({
        scope: { type: "project", projectId: ProjectId.make("project-one") },
        projectIds: [ProjectId.make("project-one"), ProjectId.make("project-two")],
        limit: 50,
      });

      expect(result.messages.map((message) => message.id)).toEqual(["message-2", "message-1"]);
    }),
  ),
);

it.effect("aggregates volume, projects, addresses, and capture latency within an inbox scope", () =>
  withStore((store) =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        [
          capturedMessage({
            id: "message-1",
            attribution: projectAttribution("one"),
            receivedAt: "2026-08-12T10:05:00.000Z",
            latencyMs: 100,
            sender: "Alice@Example.com",
            recipients: ["team@example.com"],
          }),
          capturedMessage({
            id: "message-2",
            attribution: projectAttribution("one"),
            receivedAt: "2026-08-12T10:35:00.000Z",
            latencyMs: 200,
            sender: "alice@example.com",
            recipients: ["bob@example.com"],
          }),
          capturedMessage({
            id: "message-3",
            attribution: projectAttribution("two"),
            receivedAt: "2026-08-12T11:10:00.000Z",
            latencyMs: 300,
            sender: "charlie@example.com",
            recipients: ["team@example.com"],
          }),
          capturedMessage({
            id: "message-4",
            attribution: unassignedAttribution,
            receivedAt: "2026-08-13T09:00:00.000Z",
            latencyMs: 900,
            sender: "unknown@example.com",
            recipients: ["nobody@example.com"],
          }),
        ],
        store.capture,
        { concurrency: 1 },
      );

      const analytics = yield* store.analytics({
        scope: { type: "project", projectId: ProjectId.make("project-one") },
        from: "2026-08-12T00:00:00.000Z",
        to: "2026-08-13T00:00:00.000Z",
        interval: "hour",
        topAddressLimit: 5,
      });

      expect(analytics.volumeOverTime).toEqual([
        { bucketStart: "2026-08-12T10:00:00.000Z", messageCount: 2 },
      ]);
      expect(analytics.perProjectCounts).toEqual([
        {
          projectId: ProjectId.make("project-one"),
          mailSlug: EmailMailSlug.make("project-one"),
          messageCount: 2,
        },
      ]);
      expect(analytics.topSenders).toEqual([{ address: "alice@example.com", messageCount: 2 }]);
      expect(analytics.topRecipients).toEqual([
        { address: "bob@example.com", messageCount: 1 },
        { address: "team@example.com", messageCount: 1 },
      ]);
      expect(analytics.captureLatency).toEqual({
        messageCount: 2,
        averageMs: 150,
        p50Ms: 100,
        p95Ms: 200,
        maxMs: 200,
      });
    }),
  ),
);

it.effect("keeps the unassigned inbox isolated from project analytics", () =>
  withStore((store) =>
    Effect.gen(function* () {
      yield* store.capture(
        capturedMessage({
          id: "unassigned-message",
          attribution: unassignedAttribution,
          receivedAt: "2026-08-13T09:00:00.000Z",
          latencyMs: 75,
          sender: "unknown@example.com",
          recipients: ["nobody@example.com"],
        }),
      );
      yield* store.capture(
        capturedMessage({
          id: "project-message",
          attribution: projectAttribution("one"),
          receivedAt: "2026-08-13T09:10:00.000Z",
          latencyMs: 150,
          sender: "known@example.com",
          recipients: ["dev@project-one.test"],
        }),
      );

      const analytics = yield* store.analytics({ scope: { type: "unassigned" }, interval: "day" });

      expect(analytics.perProjectCounts).toEqual([
        { projectId: null, mailSlug: null, messageCount: 1 },
      ]);
      expect(analytics.topSenders).toEqual([{ address: "unknown@example.com", messageCount: 1 }]);
      expect(analytics.captureLatency.messageCount).toBe(1);
    }),
  ),
);

it.effect("evicts each inbox independently and removes raw message files", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-mail-retention-" });
      const store = yield* makeEmailStore(path.join(directory, "mail.sqlite"));
      const older = yield* store.capture(
        capturedMessage({
          id: "older-message",
          attribution: projectAttribution("one"),
          receivedAt: "2026-08-12T10:00:00.000Z",
          latencyMs: 25,
          sender: "sender@example.com",
          recipients: ["dev@project-one.test"],
        }),
      );
      const newer = yield* store.capture(
        capturedMessage({
          id: "newer-message",
          attribution: projectAttribution("one"),
          receivedAt: "2026-08-12T11:00:00.000Z",
          latencyMs: 25,
          sender: "sender@example.com",
          recipients: ["dev@project-one.test"],
        }),
      );
      const unassigned = yield* store.capture(
        capturedMessage({
          id: "unassigned-message",
          attribution: unassignedAttribution,
          receivedAt: "2026-08-12T09:00:00.000Z",
          latencyMs: 25,
          sender: "sender@example.com",
          recipients: ["dev@example.com"],
        }),
      );

      const evicted = yield* store.applyRetention({
        policy: { maxMessages: 1, maxAgeDays: 7 },
        projects: [],
        nowMs: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-08-12T12:00:00.000Z")),
      });
      expect(evicted).toEqual([older.id]);
      expect(yield* store.getMessage(older.id)).toBeNull();
      expect(yield* store.getMessage(newer.id)).not.toBeNull();
      expect(yield* store.getMessage(unassigned.id)).not.toBeNull();
      expect(yield* fs.exists(path.join(directory, "mail", "raw", `${older.id}.eml`))).toBe(false);

      const cleared = yield* store.clear({
        type: "project",
        projectId: projectAttribution("one").projectId!,
      });
      expect(cleared).toEqual([newer.id]);
      expect(yield* fs.exists(path.join(directory, "mail", "raw", `${newer.id}.eml`))).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
