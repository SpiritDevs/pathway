import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  IssueStatusId,
  ProjectId,
  ProviderDriverKind,
  type IssueActor,
  type SlackIntakeTrigger,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { IssueCommentRepositoryLive } from "../../persistence/Layers/IssueComments.ts";
import { IssueCycleRepositoryLive } from "../../persistence/Layers/IssueCycles.ts";
import { IssueEnrichmentRunRepositoryLive } from "../../persistence/Layers/IssueEnrichmentRuns.ts";
import { IssueEventRepositoryLive } from "../../persistence/Layers/IssueEvents.ts";
import { IssueLabelRepositoryLive } from "../../persistence/Layers/IssueLabels.ts";
import { IssueMilestoneRepositoryLive } from "../../persistence/Layers/IssueMilestones.ts";
import { IssueRelationRepositoryLive } from "../../persistence/Layers/IssueRelations.ts";
import { IssueRepositoryLive } from "../../persistence/Layers/Issues.ts";
import { IssueStatusRepositoryLive } from "../../persistence/Layers/IssueStatuses.ts";
import { IssueThreadLinkRepositoryLive } from "../../persistence/Layers/IssueThreadLinks.ts";
import { IssueTodoRepositoryLive } from "../../persistence/Layers/IssueTodos.ts";
import { IssueTrackerConfigRepositoryLive } from "../../persistence/Layers/IssueTrackerConfig.ts";
import { IssueViewRepositoryLive } from "../../persistence/Layers/IssueViews.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { SlackChannelWatchRepositoryLive } from "../../persistence/Layers/SlackChannelWatches.ts";
import { SlackIntakeLedgerRepositoryLive } from "../../persistence/Layers/SlackIntakeLedger.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { IssueEnrichmentEngine } from "../IssueEnrichmentEngine.ts";
import { IssueTrackerService, layer as issueTrackerLayer } from "../IssueTrackerService.ts";
import {
  SlackApiClient,
  SlackApiError,
  type SlackApiClientShape,
  type SlackIdentity,
  type SlackMessage,
} from "./SlackApiClient.ts";
import * as SlackIntakeEngineLive from "./SlackIntakeEngineLive.ts";
import { compareSlackTs, make as makeSlackIntakePoller } from "./SlackIntakePoller.ts";
import * as SlackIntakeSignal from "./SlackIntakeSignal.ts";
import { SLACK_BOT_TOKEN_SECRET } from "./slackToken.ts";

const USER: IssueActor = { kind: "user" };
const AGENT: IssueActor = { kind: "agent", provider: ProviderDriverKind.make("claude") };
const IN_REVIEW = IssueStatusId.make("in-review");
const PROJECT = ProjectId.make("project-alpha");

const EVERY_MESSAGE: SlackIntakeTrigger = { emoji: null, everyMessage: true, botMention: false };
const ON_EMOJI: SlackIntakeTrigger = { emoji: "ticket", everyMessage: false, botMention: false };
const ON_MENTION: SlackIntakeTrigger = { emoji: null, everyMessage: false, botMention: true };

const BOT_USER_ID = "U0BOT";

const encoder = new TextEncoder();

/** Slack timestamps as this file writes them: whole seconds, six zeros, ordered by construction. */
const ts = (seconds: number): string => `${seconds}.000000`;

interface FakeSlackState {
  identity: SlackIdentity;
  /** Per channel, in any order: the fake sorts and filters the way Slack does. */
  readonly history: Map<string, Array<MutableMessage>>;
  readonly names: Map<string, string>;
  readonly permalinks: Map<string, string>;
  readonly images: Map<string, { readonly bytes: Uint8Array; readonly mimeType: string }>;
  /** Channels whose reads fail, for the containment test. */
  readonly broken: Set<string>;
  readonly posts: Array<{ channelId: string; threadTs: string; text: string; messageTs: string }>;
  readonly tokensSeen: Array<string>;
  nextPostTs: number;
}

/**
 * Slack, faked behind its own tag.
 *
 * Nothing in this file reaches the network. The fake behaves like Slack in the two ways the
 * poller depends on — history comes back newest-first, and `oldest` is exclusive — because both
 * of those are what the cursor arithmetic is written against.
 */
function makeFakeSlack(): {
  readonly state: FakeSlackState;
  readonly client: SlackApiClientShape;
} {
  const state: FakeSlackState = {
    identity: { workspaceName: "Pathway HQ", botUserId: BOT_USER_ID, botId: "B0BOT" },
    history: new Map(),
    names: new Map(),
    permalinks: new Map(),
    images: new Map(),
    broken: new Set(),
    posts: [],
    tokensSeen: [],
    nextPostTs: 9000,
  };

  const refuse = (operation: string, code: string) =>
    Effect.fail(new SlackApiError({ operation, code, status: 200, detail: null }));

  const client: SlackApiClientShape = {
    authTest: ({ token }) =>
      Effect.suspend(() => {
        state.tokensSeen.push(token);
        return token.startsWith("xoxb-")
          ? Effect.succeed(state.identity)
          : refuse("auth.test", "invalid_auth");
      }),
    listChannels: () => Effect.succeed([]),
    history: ({ token, channelId, oldest, limit, cursor }) =>
      Effect.suspend(() => {
        state.tokensSeen.push(token);
        if (state.broken.has(channelId)) return refuse("conversations.history", "not_in_channel");
        const all = (state.history.get(channelId) ?? []).filter(
          (message) =>
            oldest === undefined || oldest === null || compareSlackTs(message.ts, oldest) > 0,
        );
        const newestFirst = [...all].sort((left, right) => compareSlackTs(right.ts, left.ts));
        const size = limit ?? 200;
        // Slack pages newest-first from a numbered offset; the fake does the same, so the
        // poller's page walk is exercised rather than assumed.
        const offset = cursor === undefined || cursor === null ? 0 : Number.parseInt(cursor, 10);
        const page = newestFirst.slice(offset, offset + size);
        const hasMore = offset + size < newestFirst.length;
        return Effect.succeed({
          messages: page,
          hasMore,
          nextCursor: hasMore ? String(offset + size) : null,
        });
      }),
    replies: ({ channelId, threadTs }) =>
      Effect.suspend(() =>
        Effect.succeed(
          (state.history.get(channelId) ?? [])
            .filter((message) => message.thread_ts === threadTs)
            .sort((left, right) => compareSlackTs(left.ts, right.ts)),
        ),
      ),
    postToThread: ({ token, channelId, threadTs, text }) =>
      Effect.suspend(() => {
        state.tokensSeen.push(token);
        state.nextPostTs += 1;
        const messageTs = ts(state.nextPostTs);
        state.posts.push({ channelId, threadTs, text, messageTs });
        return Effect.succeed({ messageTs });
      }),
    permalink: ({ channelId, messageTs }) =>
      Effect.succeed(state.permalinks.get(`${channelId}:${messageTs}`) ?? null),
    displayName: ({ userId }) => Effect.succeed(state.names.get(userId) ?? null),
    downloadImage: ({ url }) => Effect.succeed(state.images.get(url) ?? null),
  };

  return { state, client };
}

/**
 * Everything under the poller: a real tracker over an in-memory database, the real intake engine,
 * and Slack faked at its own tag. Only the network is a fake — the ledger, the cursors and the
 * echo registry are the real tables, because those are what the tests are about.
 */
const makeTestLayer = (client: SlackApiClientShape) => {
  const repositories = Layer.mergeAll(
    IssueRepositoryLive,
    IssueStatusRepositoryLive,
    IssueLabelRepositoryLive,
    IssueEventRepositoryLive,
    IssueTrackerConfigRepositoryLive,
    IssueMilestoneRepositoryLive,
    IssueCycleRepositoryLive,
    IssueTodoRepositoryLive,
    IssueRelationRepositoryLive,
    IssueCommentRepositoryLive,
    IssueViewRepositoryLive,
    IssueEnrichmentRunRepositoryLive,
    IssueThreadLinkRepositoryLive,
    SlackChannelWatchRepositoryLive,
    SlackIntakeLedgerRepositoryLive,
    ProjectionProjectRepositoryLive,
  ).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-slack-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );

  const engine = SlackIntakeEngineLive.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(Layer.succeed(SlackApiClient, client), SlackIntakeSignal.layer),
    ),
  );

  const tracker = issueTrackerLayer.pipe(
    Layer.provide(
      Layer.succeed(IssueEnrichmentEngine, {
        resolveModelSelection: Effect.succeed({
          instanceId: ProviderDriverKind.make("codex") as never,
          model: "gpt-5-codex",
        }),
        start: () => Effect.void,
        cancel: () => Effect.void,
      }),
    ),
    Layer.provideMerge(engine),
    Layer.provideMerge(repositories),
  );

  return tracker;
};

/** Everything the harness provides, so a test body can ask for any of it. */
type TestHarness = Layer.Success<ReturnType<typeof makeTestLayer>>;

const storeToken = (token: string) =>
  Effect.flatMap(ServerSecretStore.ServerSecretStore, (store) =>
    store.set(SLACK_BOT_TOKEN_SECRET, encoder.encode(token)),
  );

/**
 * A message a test can go back and change — a reaction is added to a message that is already in
 * the channel, which is the whole point of the reaction window.
 */
type MutableMessage = { -readonly [K in keyof SlackMessage]: SlackMessage[K] };

const message = (input: Partial<MutableMessage> & { readonly ts: string }): MutableMessage => ({
  user: "U100",
  text: "hello",
  ...input,
});

describe("SlackIntakePoller", () => {
  /** One test's world: the harness built fresh, so the key counter and the tables are its own. */
  const run = <A, E>(client: SlackApiClientShape, body: Effect.Effect<A, E, TestHarness>) =>
    body.pipe(Effect.provide(makeTestLayer(client)));

  const poller = makeSlackIntakePoller;

  it.effect("plants the cursor on the first pass and files nothing", () => {
    const { state, client } = makeFakeSlack();
    state.history.set("C1", [message({ ts: ts(100), text: "old chatter" })]);

    return run(
      client,
      Effect.gen(function* () {
        const tracker = yield* IssueTrackerService;
        yield* storeToken("xoxb-1");
        yield* tracker.slackWatchCreate({
          channelId: "C1",
          channelName: "support",
          trigger: EVERY_MESSAGE,
        });
        const intake = yield* poller;

        yield* intake.pollOnce;
        const first = yield* tracker.getSnapshot();
        assert.strictEqual(first.issues.length, 0);

        // Everything said after the watch was created is what a watch means.
        state.history.get("C1")!.push(message({ ts: ts(200), text: "the build is red" }));
        yield* intake.pollOnce;

        const second = yield* tracker.getSnapshot();
        assert.strictEqual(second.issues.length, 1);
        assert.strictEqual(second.issues[0]?.title, "the build is red");
        assert.strictEqual(second.issues[0]?.triage, true);
      }),
    );
  });

  it.effect("files on every message, on a mention, and on the trigger reaction", () => {
    const { state, client } = makeFakeSlack();
    state.history.set("C1", []);
    state.history.set("C2", []);
    state.history.set("C3", []);
    state.names.set(BOT_USER_ID, "Pathway");

    return run(
      client,
      Effect.gen(function* () {
        const tracker = yield* IssueTrackerService;
        yield* storeToken("xoxb-1");
        yield* tracker.slackWatchCreate({
          channelId: "C1",
          channelName: "everything",
          trigger: EVERY_MESSAGE,
        });
        yield* tracker.slackWatchCreate({
          channelId: "C2",
          channelName: "mentions",
          trigger: ON_MENTION,
        });
        yield* tracker.slackWatchCreate({
          channelId: "C3",
          channelName: "reactions",
          trigger: ON_EMOJI,
        });
        const intake = yield* poller;
        yield* intake.pollOnce;

        state.history.get("C1")!.push(message({ ts: ts(200), text: "anything at all" }));
        state.history
          .get("C2")!
          .push(
            message({ ts: ts(201), text: "no mention here" }),
            message({ ts: ts(202), text: `<@${BOT_USER_ID}> please file this` }),
          );
        state.history
          .get("C3")!
          .push(
            message({ ts: ts(203), text: "unreacted" }),
            message({ ts: ts(204), text: "reacted", reactions: [{ name: "ticket" }] }),
          );
        yield* intake.pollOnce;

        const titles = (yield* tracker.getSnapshot()).issues.map((issue) => issue.title).sort();
        assert.deepStrictEqual(titles, ["@Pathway please file this", "anything at all", "reacted"]);
      }),
    );
  });

  it.effect("finds the trigger reaction on a message the cursor has already gone past", () => {
    const { state, client } = makeFakeSlack();
    state.history.set("C1", []);

    return run(
      client,
      Effect.gen(function* () {
        const tracker = yield* IssueTrackerService;
        yield* storeToken("xoxb-1");
        yield* tracker.slackWatchCreate({
          channelId: "C1",
          channelName: "reactions",
          trigger: ON_EMOJI,
        });
        const intake = yield* poller;
        yield* intake.pollOnce;

        const older = message({ ts: ts(200), text: "nobody cared yet" });
        state.history.get("C1")!.push(older);
        // Read once with no reaction: the cursor is now past it, so no later history call can
        // return it again. Only the reaction window can.
        yield* intake.pollOnce;
        assert.strictEqual((yield* tracker.getSnapshot()).issues.length, 0);

        older.reactions = [{ name: "ticket" }];
        yield* intake.pollOnce;

        const issues = (yield* tracker.getSnapshot()).issues;
        assert.strictEqual(issues.length, 1);
        assert.strictEqual(issues[0]?.title, "nobody cared yet");
      }),
    );
  });

  it.effect("walks every page of a backlog, so a sleepy server catches up", () => {
    const { state, client } = makeFakeSlack();
    state.history.set("C1", [message({ ts: ts(100), text: "before the watch" })]);

    return run(
      client,
      Effect.gen(function* () {
        const tracker = yield* IssueTrackerService;
        yield* storeToken("xoxb-1");
        yield* tracker.slackWatchCreate({
          channelId: "C1",
          channelName: "firehose",
          trigger: EVERY_MESSAGE,
        });
        const intake = yield* poller;
        yield* intake.pollOnce;

        // Three pages' worth at the client's page size of 200, all said while the laptop slept.
        for (let index = 0; index < 450; index += 1) {
          state.history.get("C1")!.push(message({ ts: ts(1000 + index), text: `line ${index}` }));
        }
        yield* intake.pollOnce;

        assert.strictEqual((yield* tracker.getSnapshot()).issues.length, 450);
      }),
    );
  });

  it.effect("files a message once, however many passes read it", () => {
    const { state, client } = makeFakeSlack();
    state.history.set("C1", []);

    return run(
      client,
      Effect.gen(function* () {
        const tracker = yield* IssueTrackerService;
        yield* storeToken("xoxb-1");
        yield* tracker.slackWatchCreate({
          channelId: "C1",
          channelName: "support",
          trigger: ON_EMOJI,
        });
        const intake = yield* poller;
        yield* intake.pollOnce;

        state.history
          .get("C1")!
          .push(message({ ts: ts(200), text: "file me", reactions: [{ name: "ticket" }] }));
        yield* intake.pollOnce;
        // The reaction window overlaps what the main pass just read, on this cycle and the next.
        yield* intake.pollOnce;
        yield* intake.pollOnce;

        assert.strictEqual((yield* tracker.getSnapshot()).issues.length, 1);
        assert.strictEqual(
          state.posts.filter((post) => post.text.startsWith("Filed")).length,
          1,
          "one confirmation, not one per pass",
        );
      }),
    );
  });

  it.effect("answers in the thread with the key and the route, and never reads it back", () => {
    const { state, client } = makeFakeSlack();
    state.history.set("C1", []);

    return run(
      client,
      Effect.gen(function* () {
        const tracker = yield* IssueTrackerService;
        yield* storeToken("xoxb-1");
        yield* tracker.slackWatchCreate({
          channelId: "C1",
          channelName: "support",
          projectId: PROJECT,
          trigger: EVERY_MESSAGE,
        });
        const intake = yield* poller;
        yield* intake.pollOnce;

        state.history.get("C1")!.push(message({ ts: ts(200), text: "the build is red" }));
        yield* intake.pollOnce;

        const issue = (yield* tracker.getSnapshot()).issues[0];
        assert.ok(issue);
        assert.strictEqual(issue.projectId, PROJECT);
        assert.deepStrictEqual(issue.slackSource, {
          issueId: issue.id,
          channelId: "C1",
          messageTs: ts(200),
          permalink: null,
          authorName: null,
        });

        const confirmation = state.posts.at(-1);
        assert.ok(confirmation);
        assert.strictEqual(confirmation.threadTs, ts(200));
        assert.strictEqual(
          confirmation.text,
          `Filed *${issue.key}*: the build is red\nOpen in Pathway: /issues?issue=${issue.key}`,
        );

        // The bot's own confirmation is now a message in a watched channel. It must not become
        // an issue — that is the whole job of the outbound registry.
        state.history.get("C1")!.push(
          message({
            ts: confirmation.messageTs,
            text: confirmation.text,
            user: BOT_USER_ID,
          }),
        );
        yield* intake.pollOnce;
        assert.strictEqual((yield* tracker.getSnapshot()).issues.length, 1);
      }),
    );
  });

  it.effect("attaches a thread reply to the issue its parent became", () => {
    const { state, client } = makeFakeSlack();
    state.history.set("C1", []);
    state.names.set("U200", "Ann Rivers");

    return run(
      client,
      Effect.gen(function* () {
        const tracker = yield* IssueTrackerService;
        yield* storeToken("xoxb-1");
        yield* tracker.slackWatchCreate({
          channelId: "C1",
          channelName: "support",
          trigger: EVERY_MESSAGE,
        });
        const intake = yield* poller;
        yield* intake.pollOnce;

        state.history.get("C1")!.push(message({ ts: ts(200), text: "the build is red" }));
        yield* intake.pollOnce;
        const issue = (yield* tracker.getSnapshot()).issues[0];
        assert.ok(issue);

        state.history.get("C1")!.push(
          message({
            ts: ts(201),
            thread_ts: ts(200),
            user: "U200",
            text: "it is the *cache* again",
          }),
        );
        yield* intake.pollOnce;
        yield* intake.pollOnce;

        const detail = yield* tracker.getDetail({ issueId: issue.id });
        assert.strictEqual(detail.comments.length, 1);
        assert.strictEqual(detail.comments[0]?.body, "**Ann Rivers:** it is the **cache** again");
        assert.deepStrictEqual(detail.comments[0]?.author, { kind: "system", source: "slack" });
      }),
    );
  });

  it.effect("leaves a reply on a thread that is not an issue entirely alone", () => {
    const { state, client } = makeFakeSlack();
    state.history.set("C1", []);

    return run(
      client,
      Effect.gen(function* () {
        const tracker = yield* IssueTrackerService;
        yield* storeToken("xoxb-1");
        yield* tracker.slackWatchCreate({
          channelId: "C1",
          channelName: "support",
          trigger: ON_EMOJI,
        });
        const intake = yield* poller;
        yield* intake.pollOnce;

        const parent = message({ ts: ts(200), text: "a normal conversation" });
        state.history
          .get("C1")!
          .push(parent, message({ ts: ts(201), thread_ts: ts(200), text: "yes, agreed" }));
        yield* intake.pollOnce;
        assert.strictEqual((yield* tracker.getSnapshot()).issues.length, 0);

        // Somebody reacts a day later. The reply that was already read has to come with it.
        parent.reactions = [{ name: "ticket" }];
        parent.reply_count = 1;
        yield* intake.pollOnce;

        const issue = (yield* tracker.getSnapshot()).issues[0];
        assert.ok(issue);
        const detail = yield* tracker.getDetail({ issueId: issue.id });
        assert.strictEqual(detail.comments.length, 1);
        assert.strictEqual(detail.comments[0]?.body, "yes, agreed");
      }),
    );
  });

  it.effect("keeps one broken channel from stopping the others, and says which broke", () => {
    const { state, client } = makeFakeSlack();
    state.history.set("C1", []);
    state.history.set("C2", []);

    return run(
      client,
      Effect.gen(function* () {
        const tracker = yield* IssueTrackerService;
        yield* storeToken("xoxb-1");
        yield* tracker.slackWatchCreate({
          channelId: "C1",
          channelName: "design",
          trigger: EVERY_MESSAGE,
        });
        yield* tracker.slackWatchCreate({
          channelId: "C2",
          channelName: "support",
          trigger: EVERY_MESSAGE,
        });
        const intake = yield* poller;
        yield* intake.pollOnce;

        state.broken.add("C1");
        state.history.get("C2")!.push(message({ ts: ts(200), text: "still reading this one" }));
        yield* intake.pollOnce;

        assert.strictEqual((yield* tracker.getSnapshot()).issues.length, 1);
        const { status } = yield* tracker.slackGetStatus();
        assert.strictEqual(
          status.lastError,
          "#design: The bot is not in that channel. Invite it there and it will start reading.",
        );
        assert.ok(status.lastPollAt !== null);

        // A pass with nothing wrong clears it.
        state.broken.delete("C1");
        yield* intake.pollOnce;
        assert.strictEqual((yield* tracker.slackGetStatus()).status.lastError, null);
      }),
    );
  });

  it.effect("reports a token Slack will not accept as the whole integration's problem", () => {
    const { state, client } = makeFakeSlack();
    state.history.set("C1", []);

    return run(
      client,
      Effect.gen(function* () {
        const tracker = yield* IssueTrackerService;
        yield* storeToken("nonsense");
        yield* tracker.slackWatchCreate({
          channelId: "C1",
          channelName: "support",
          trigger: EVERY_MESSAGE,
        });
        const intake = yield* poller;
        yield* intake.pollOnce;

        assert.strictEqual(
          (yield* tracker.slackGetStatus()).status.lastError,
          "Slack rejected the bot token. Generate a new one and save it again.",
        );
      }),
    );
  });

  it.effect("reads the token again on every cycle, so a new one applies without a restart", () => {
    const { state, client } = makeFakeSlack();
    state.history.set("C1", []);

    return run(
      client,
      Effect.gen(function* () {
        const tracker = yield* IssueTrackerService;
        yield* storeToken("xoxb-first");
        yield* tracker.slackWatchCreate({
          channelId: "C1",
          channelName: "support",
          trigger: EVERY_MESSAGE,
        });
        const intake = yield* poller;
        yield* intake.pollOnce;
        assert.deepStrictEqual(new Set(state.tokensSeen), new Set(["xoxb-first"]));

        yield* storeToken("xoxb-second");
        state.tokensSeen.length = 0;
        yield* intake.pollOnce;

        assert.deepStrictEqual(new Set(state.tokensSeen), new Set(["xoxb-second"]));
      }),
    );
  });

  it.effect("does nothing at all without a token or without an active watch", () => {
    const { state, client } = makeFakeSlack();
    state.history.set("C1", [message({ ts: ts(200) })]);

    return run(
      client,
      Effect.gen(function* () {
        const tracker = yield* IssueTrackerService;
        const intake = yield* poller;

        // No token.
        yield* tracker.slackWatchCreate({
          channelId: "C1",
          channelName: "support",
          trigger: EVERY_MESSAGE,
        });
        yield* intake.pollOnce;
        assert.strictEqual(state.tokensSeen.length, 0);

        // A token, but the only watch is paused.
        yield* storeToken("xoxb-1");
        const watches = (yield* tracker.slackGetStatus(), yield* tracker.getSnapshot())
          .slackWatches;
        yield* tracker.slackWatchUpdate({
          watchId: watches[0]!.id,
          patch: { trigger: { emoji: null, everyMessage: false, botMention: false } },
        });
        yield* intake.pollOnce;
        assert.strictEqual(state.tokensSeen.length, 0);
      }),
    );
  });

  it.effect("carries a Slack image onto the issue as a comment attachment", () => {
    const { state, client } = makeFakeSlack();
    state.history.set("C1", []);
    state.images.set("https://files.slack.test/shot.png", {
      bytes: new Uint8Array([137, 80, 78, 71]),
      mimeType: "image/png",
    });

    return run(
      client,
      Effect.gen(function* () {
        const tracker = yield* IssueTrackerService;
        yield* storeToken("xoxb-1");
        yield* tracker.slackWatchCreate({
          channelId: "C1",
          channelName: "support",
          trigger: EVERY_MESSAGE,
        });
        const intake = yield* poller;
        yield* intake.pollOnce;

        state.history.get("C1")!.push(
          message({
            ts: ts(200),
            subtype: "file_share",
            text: "look at this",
            files: [
              {
                mimetype: "image/png",
                name: "shot.png",
                url_private: "https://files.slack.test/shot.png",
              },
            ],
          }),
        );
        yield* intake.pollOnce;

        const issue = (yield* tracker.getSnapshot()).issues[0];
        assert.ok(issue);
        const detail = yield* tracker.getDetail({ issueId: issue.id });
        assert.strictEqual(detail.comments.length, 1);
        assert.strictEqual(detail.comments[0]?.body, "attached an image in Slack.");
        assert.strictEqual(detail.comments[0]?.attachmentIds.length, 1);
      }),
    );
  });

  it.effect("posts a status change into the source thread, attributed to whoever moved it", () => {
    const { state, client } = makeFakeSlack();
    state.history.set("C1", []);

    return run(
      client,
      Effect.gen(function* () {
        const tracker = yield* IssueTrackerService;
        yield* storeToken("xoxb-1");
        yield* tracker.slackWatchCreate({
          channelId: "C1",
          channelName: "support",
          trigger: EVERY_MESSAGE,
        });
        const intake = yield* poller;
        yield* intake.pollOnce;
        state.history.get("C1")!.push(message({ ts: ts(200), text: "the build is red" }));
        yield* intake.pollOnce;

        const issue = (yield* tracker.getSnapshot()).issues[0];
        assert.ok(issue);
        // The opening replay is what the outbound side learns the issue from; a first sighting
        // is never a change.
        yield* intake.handleStreamEvent({ _tag: "IssueUpserted", issue });
        const before = state.posts.length;

        const moved = yield* tracker.update(
          { issueId: issue.id, patch: { statusId: IN_REVIEW, triage: false } },
          USER,
        );
        yield* intake.handleStreamEvent({ _tag: "IssueUpserted", issue: moved.issue });

        assert.strictEqual(state.posts.length, before + 1);
        assert.strictEqual(
          state.posts.at(-1)?.text,
          `Pathway user moved ${issue.key} to In Review`,
        );
        assert.strictEqual(state.posts.at(-1)?.threadTs, ts(200));
      }),
    );
  });

  it.effect("posts a person's comment and refuses to post the ones Slack sent in", () => {
    const { state, client } = makeFakeSlack();
    state.history.set("C1", []);

    return run(
      client,
      Effect.gen(function* () {
        const tracker = yield* IssueTrackerService;
        yield* storeToken("xoxb-1");
        yield* tracker.slackWatchCreate({
          channelId: "C1",
          channelName: "support",
          trigger: EVERY_MESSAGE,
        });
        const intake = yield* poller;
        yield* intake.pollOnce;
        state.history.get("C1")!.push(message({ ts: ts(200), text: "the build is red" }));
        yield* intake.pollOnce;

        const issue = (yield* tracker.getSnapshot()).issues[0];
        assert.ok(issue);
        yield* intake.handleStreamEvent({ _tag: "IssueUpserted", issue });
        const before = state.posts.length;

        const agent = yield* tracker.commentCreate(
          { issueId: issue.id, body: "Looks like a **cache** bug." },
          AGENT,
        );
        yield* intake.handleStreamEvent({
          _tag: "IssueCommentUpserted",
          comment: agent.comment,
        });
        assert.strictEqual(state.posts.length, before + 1);
        assert.strictEqual(state.posts.at(-1)?.text, "Claude: Looks like a *cache* bug.");

        // The reply intake itself wrote. Posting it back is the loop the registry exists to stop.
        const echoed = yield* tracker.intakeAddComment({
          channelId: "C1",
          threadTs: ts(200),
          messageTs: ts(201),
          authorName: "Ann",
          body: "from slack",
        });
        assert.ok(echoed.comment);
        yield* intake.handleStreamEvent({
          _tag: "IssueCommentUpserted",
          comment: echoed.comment,
        });
        assert.strictEqual(state.posts.length, before + 1);

        // An edit is a republish of a comment already posted, not a new one.
        const edited = yield* tracker.commentUpdate(
          { commentId: agent.comment.id, patch: { body: "Actually a config bug." } },
          AGENT,
        );
        yield* intake.handleStreamEvent({
          _tag: "IssueCommentUpserted",
          comment: edited.comment,
        });
        assert.strictEqual(state.posts.length, before + 1);
      }),
    );
  });

  it.effect("says nothing about an issue that did not come from Slack", () => {
    const { state, client } = makeFakeSlack();

    return run(
      client,
      Effect.gen(function* () {
        const tracker = yield* IssueTrackerService;
        const intake = yield* poller;
        const { issue } = yield* tracker.create({ title: "Typed in by hand" }, USER);
        yield* intake.handleStreamEvent({ _tag: "IssueUpserted", issue });

        const moved = yield* tracker.update(
          { issueId: issue.id, patch: { statusId: IN_REVIEW } },
          USER,
        );
        yield* intake.handleStreamEvent({ _tag: "IssueUpserted", issue: moved.issue });

        assert.strictEqual(state.posts.length, 0);
      }),
    );
  });

  it.effect("records every outbound post so the next pass cannot read it back", () => {
    const { state, client } = makeFakeSlack();
    state.history.set("C1", []);

    return run(
      client,
      Effect.gen(function* () {
        const tracker = yield* IssueTrackerService;
        yield* storeToken("xoxb-1");
        yield* tracker.slackWatchCreate({
          channelId: "C1",
          channelName: "support",
          trigger: EVERY_MESSAGE,
        });
        const intake = yield* poller;
        yield* intake.pollOnce;
        state.history.get("C1")!.push(message({ ts: ts(200), text: "the build is red" }));
        yield* intake.pollOnce;

        const issue = (yield* tracker.getSnapshot()).issues[0];
        assert.ok(issue);
        yield* intake.handleStreamEvent({ _tag: "IssueUpserted", issue });
        const comment = yield* tracker.commentCreate({ issueId: issue.id, body: "on it" }, USER);
        yield* intake.handleStreamEvent({
          _tag: "IssueCommentUpserted",
          comment: comment.comment,
        });

        const outbound = state.posts.at(-1);
        assert.ok(outbound);
        // Put the bot's own post back into the channel, authored by a person, so only the
        // registry — not the bot-author skip — can keep it out.
        state.history
          .get("C1")!
          .push(message({ ts: outbound.messageTs, text: outbound.text, user: "U300" }));
        yield* intake.pollOnce;

        assert.strictEqual((yield* tracker.getSnapshot()).issues.length, 1);
      }),
    );
  });
});

describe("compareSlackTs", () => {
  it("orders by seconds and then by microseconds, past what a double can hold", () => {
    expect(compareSlackTs("1723459200.001900", "1723459200.001901")).toBe(-1);
    expect(compareSlackTs("1723459201.000000", "1723459200.999999")).toBe(1);
    expect(compareSlackTs("1723459200.000100", "1723459200.000100")).toBe(0);
  });
});
