/**
 * The enrichment engine, driven end to end over an in-memory tracker with a fake provider.
 *
 * The fake is a `TextGeneration` whose `investigate` is whatever the test needs it to be — no CLI
 * is ever spawned, which is why that operation takes a prompt and returns text rather than owning
 * a process. What is under test is the state machine either side of it: the permit that keeps one
 * run in flight, the transcript that arrives while it runs, the tolerant parse of what it said,
 * the block that lands on the description, and what a cancel does to all of that.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  IssueEnrichmentResult,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  TextGenerationError,
  type ChatAttachmentId,
  type IssueActor,
  type IssueEnrichmentRun,
  type IssueEnrichmentRunId,
  type IssueId,
} from "@t3tools/contracts";

import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { IssueCommentRepositoryLive } from "../persistence/Layers/IssueComments.ts";
import { IssueCycleRepositoryLive } from "../persistence/Layers/IssueCycles.ts";
import { IssueEnrichmentRunRepositoryLive } from "../persistence/Layers/IssueEnrichmentRuns.ts";
import { IssueEventRepositoryLive } from "../persistence/Layers/IssueEvents.ts";
import { IssueLabelRepositoryLive } from "../persistence/Layers/IssueLabels.ts";
import { IssueMilestoneRepositoryLive } from "../persistence/Layers/IssueMilestones.ts";
import { IssueRelationRepositoryLive } from "../persistence/Layers/IssueRelations.ts";
import { IssueRepositoryLive } from "../persistence/Layers/Issues.ts";
import { IssueStatusRepositoryLive } from "../persistence/Layers/IssueStatuses.ts";
import { IssueThreadLinkRepositoryLive } from "../persistence/Layers/IssueThreadLinks.ts";
import { IssueTodoRepositoryLive } from "../persistence/Layers/IssueTodos.ts";
import { IssueTrackerConfigRepositoryLive } from "../persistence/Layers/IssueTrackerConfig.ts";
import { IssueViewRepositoryLive } from "../persistence/Layers/IssueViews.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { SlackChannelWatchRepositoryLive } from "../persistence/Layers/SlackChannelWatches.ts";
import { SlackIntakeLedgerRepositoryLive } from "../persistence/Layers/SlackIntakeLedger.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as IssueEnrichmentEngineLive from "./IssueEnrichmentEngineLive.ts";
import * as SlackIntakeEngine from "./slack/SlackIntakeEngine.ts";
import { IssueTrackerService, layer as issueTrackerLayer } from "./IssueTrackerService.ts";

const ACTOR: IssueActor = { kind: "user" };
const PROJECT = ProjectId.make("project-alpha");
const WORKSPACE_ROOT = "/tmp/pathway";
/** A 1x1 transparent PNG — the smallest thing that is genuinely an image. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

type Investigate = TextGeneration.TextGeneration["Service"]["investigate"];

/** Only `investigate` is exercised; the rest die loudly rather than returning a plausible lie. */
const makeFakeTextGeneration = (
  investigate: Investigate,
): TextGeneration.TextGeneration["Service"] => ({
  generateCommitMessage: () => Effect.die("generateCommitMessage is not used by enrichment"),
  generatePrContent: () => Effect.die("generatePrContent is not used by enrichment"),
  generateBranchName: () => Effect.die("generateBranchName is not used by enrichment"),
  generateThreadTitle: () => Effect.die("generateThreadTitle is not used by enrichment"),
  investigate,
});

/**
 * Everything the tracker and the engine read, over one in-memory database. Merged out so a test
 * can seed a project before either service exists.
 */
const DependenciesLive = Layer.mergeAll(
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
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-enrichment-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

/**
 * One instance per driver kind, keyed by its own kind — the shape the defaults produce, where the
 * instance id and the driver kind are the same word.
 *
 * The engine reads exactly one field of this, `driverKind`, to decide whether the issue's images
 * are worth reading at all; everything else is scaffolding the type demands.
 */
const providerRegistryLayer = (kinds: ReadonlyArray<string> = ["codex", "claudeAgent"]) => {
  const instances = kinds.map(
    (kind) =>
      ({
        instanceId: ProviderInstanceId.make(kind),
        driverKind: ProviderDriverKind.make(kind),
        continuationIdentity: {
          driverKind: ProviderDriverKind.make(kind),
          continuationKey: `${kind}:instance:${kind}`,
        },
        displayName: undefined,
        enabled: true,
        snapshot: {} as ProviderInstance["snapshot"],
        orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
        textGeneration: {} as ProviderInstance["textGeneration"],
      }) satisfies ProviderInstance,
  );
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance] as const));

  return Layer.succeed(ProviderInstanceRegistry, {
    getInstance: (instanceId) => Effect.succeed(byId.get(instanceId)),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  });
};

/**
 * The real tracker over the real engine, built on the database already in context. Only the
 * provider is faked, and the settings are the defaults — which is what pins the run's model to
 * `codex` and makes the agent actor on the description edit predictable.
 *
 * `enrichmentInstanceId` moves the run to another provider, which is how the tests reach the
 * capability gate: only the codex driver can be handed an image.
 */
const buildTracker = (
  investigate: Investigate,
  options: { readonly enrichmentInstanceId?: string } = {},
) =>
  Effect.provide(
    IssueTrackerService,
    issueTrackerLayer.pipe(
      Layer.provide(
        IssueEnrichmentEngineLive.layer.pipe(
          Layer.provide(
            Layer.succeed(TextGeneration.TextGeneration, makeFakeTextGeneration(investigate)),
          ),
          Layer.provide(providerRegistryLayer()),
          Layer.provide(
            serverSettingsLayerTest(
              options.enrichmentInstanceId === undefined
                ? {}
                : {
                    issueEnrichmentModelSelection: {
                      instanceId: ProviderInstanceId.make(options.enrichmentInstanceId),
                      model: "a-model",
                    },
                  },
            ),
          ),
        ),
      ),
      // Intake is not what these tests are about; the stub is enough to satisfy the tracker.
      Layer.provide(SlackIntakeEngine.layerStub),
    ),
  );

const seedProject = Effect.flatMap(ProjectionProjectRepository, (projects) =>
  projects.upsert({
    projectId: PROJECT,
    title: "Pathway",
    workspaceRoot: WORKSPACE_ROOT,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    scripts: [],
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    deletedAt: null,
  }),
);

type Tracker = IssueTrackerService["Service"];

const runState = (tracker: Tracker, issueId: IssueId, runId: IssueEnrichmentRunId) =>
  tracker
    .getEnrichmentRuns({ issueId })
    .pipe(
      Effect.map(
        ({ runs }) => runs.find((candidate) => candidate.id === runId)?.state ?? "missing",
      ),
    );

/**
 * Poll until a run reaches a terminal state.
 *
 * A run is driven by a detached fiber, so there is no handle to await from out here — which is
 * the position the UI is in too, watching the stream.
 */
const awaitFinished = (tracker: Tracker, issueId: IssueId, runId: IssueEnrichmentRunId) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const { runs } = yield* tracker.getEnrichmentRuns({ issueId });
      const run = runs.find((candidate) => candidate.id === runId);
      if (run && (run.state === "done" || run.state === "failed")) return run;
      yield* Effect.sleep(5);
    }
    return yield* Effect.die(`enrichment run ${runId} never finished`);
  });

const issueById = (tracker: Tracker, issueId: IssueId) =>
  tracker
    .getSnapshot()
    .pipe(Effect.map(({ issues }) => issues.find((candidate) => candidate.id === issueId)!));

/** The finished answer a fake provider prints. Encoded through the contract, not hand-written. */
const encodeAnswer = Schema.encodeSync(Schema.fromJsonString(IssueEnrichmentResult));

const ANSWER = {
  summary: "The reconnect path drops the queued turn.",
  likelyFiles: [{ path: "apps/server/src/ws.ts", reason: "Owns reconnect" }],
  relatedIssueKeys: [],
  suggestedLabels: ["bug"],
  suggestedPriority: "high",
} satisfies IssueEnrichmentResult;

describe("IssueEnrichmentEngineLive", () => {
  it.effect("streams the transcript, records the result, and leaves an agent comment", () =>
    Effect.gen(function* () {
      const tracker = yield* buildTracker(({ onOutput }) =>
        Effect.gen(function* () {
          yield* onOutput?.("reading files\n") ?? Effect.void;
          yield* onOutput?.("thinking\n") ?? Effect.void;
          // Fenced, because a model told "no code fence" writes one often enough anyway.
          return { text: ["```json", encodeAnswer(ANSWER), "```"].join("\n") };
        }),
      );
      yield* seedProject;
      yield* tracker.createLabel({ name: "Bug", color: "#eb5757" });
      const { issue } = yield* tracker.create(
        { title: "Reconnect drops the queued turn", description: "Body.", projectId: PROJECT },
        ACTOR,
      );

      const { run } = yield* tracker.startEnrichment({ issueId: issue.id });
      const finished = yield* awaitFinished(tracker, issue.id, run.id);

      assert.strictEqual(finished.state, "done");
      assert.strictEqual(finished.error, null);
      assert.strictEqual(finished.result?.summary, ANSWER.summary);
      // The model answered "bug"; it is stored as the tracker spells it so "apply" resolves.
      assert.deepStrictEqual(finished.result?.suggestedLabels, ["Bug"]);
      assert.isNotNull(finished.startedAt);
      assert.isNotNull(finished.finishedAt);
      // Everything the process printed reached the record, in order, even though the pump only
      // wakes every 250ms: the last window is flushed when the run ends.
      assert.strictEqual(finished.transcript, "reading files\nthinking\n");

      const updated = yield* issueById(tracker, issue.id);
      assert.strictEqual(updated.description, "Body.");
      // Suggestions are suggestions: the run applied neither the label nor the priority.
      assert.deepStrictEqual(updated.labelIds, []);
      assert.strictEqual(updated.priority, "none");

      const detail = yield* tracker.getDetail({ issueId: issue.id });
      assert.strictEqual(detail.comments.length, 1);
      assert.include(detail.comments[0]?.body ?? "", "- `apps/server/src/ws.ts` — Owns reconnect");
      assert.include(detail.comments[0]?.body ?? "", "**Suggested** (not applied)");
      assert.deepStrictEqual(detail.comments[0]?.author, {
        kind: "agent",
        provider: ProviderDriverKind.make("codex"),
      });

      // A completed investigation no longer creates a noisy description edit in Activity.
      const { events } = yield* tracker.getEvents({ issueId: issue.id });
      const descriptionChange = events.find((event) => event.field === "description");
      assert.isUndefined(descriptionChange);
    }).pipe(Effect.provide(DependenciesLive), TestClock.withLive),
  );

  it.effect("coalesces a chatty provider into one transcript publish per window", () =>
    Effect.gen(function* () {
      const CHUNKS = 60;
      const tracker = yield* buildTracker(({ onOutput }) =>
        Effect.gen(function* () {
          // Emitted back to back, the way a model streams tokens. Nothing here sleeps, so the
          // whole burst lands inside one 250ms window.
          for (let index = 0; index < CHUNKS; index += 1) {
            yield* onOutput?.(`token-${index} `) ?? Effect.void;
          }
          return { text: encodeAnswer(ANSWER) };
        }),
      );
      yield* seedProject;
      const { issue } = yield* tracker.create({ title: "Chatty", projectId: PROJECT }, ACTOR);

      const seen = yield* Ref.make<Array<IssueEnrichmentRun>>([]);
      const subscription = yield* Effect.forkChild(
        tracker.stream.pipe(
          Stream.runForEach((event) =>
            event._tag === "EnrichmentRunChanged"
              ? Ref.update(seen, (current) => [...current, event.run])
              : Effect.void,
          ),
        ),
      );

      const { run } = yield* tracker.startEnrichment({ issueId: issue.id });
      const finished = yield* awaitFinished(tracker, issue.id, run.id);
      assert.strictEqual(finished.state, "done");
      yield* Fiber.interrupt(subscription);

      const published = (yield* Ref.get(seen)).filter((candidate) => candidate.id === run.id);
      const withTranscript = published.filter((candidate) => candidate.transcript.length > 0);

      // The point of the pump: `appendTranscript` republishes the whole row, so an unthrottled
      // `onOutput` would put all 60 of these on the socket. A window's worth is one publish.
      assert.isAtLeast(withTranscript.length, 1);
      assert.isBelow(withTranscript.length, 5);
      // Coalesced, not dropped: every token still reached the record, in order.
      assert.strictEqual(
        finished.transcript,
        Array.from({ length: CHUNKS }, (_unused, index) => `token-${index} `).join(""),
      );
    }).pipe(Effect.provide(DependenciesLive), TestClock.withLive),
  );

  it.effect("fails the run with the tail of the output when nothing parses", () =>
    Effect.gen(function* () {
      const tracker = yield* buildTracker(() =>
        Effect.succeed({ text: "I read a lot of files. I could not work it out." }),
      );
      yield* seedProject;
      const { issue } = yield* tracker.create({ title: "Unparseable", projectId: PROJECT }, ACTOR);

      const { run } = yield* tracker.startEnrichment({ issueId: issue.id });
      const finished = yield* awaitFinished(tracker, issue.id, run.id);

      assert.strictEqual(finished.state, "failed");
      assert.strictEqual(finished.result, null);
      // The tail, not "invalid output": this is the only place a human sees what was said.
      assert.include(finished.error ?? "", "I could not work it out.");

      // A failed run leaves the description alone.
      const updated = yield* issueById(tracker, issue.id);
      assert.notInclude(updated.description, "Investigation");
    }).pipe(Effect.provide(DependenciesLive), TestClock.withLive),
  );

  it.effect("fails the run when the provider itself refuses", () =>
    Effect.gen(function* () {
      const tracker = yield* buildTracker(() =>
        Effect.fail(
          new TextGenerationError({
            operation: "investigate",
            detail: "Codex CLI is required but not available on PATH.",
          }),
        ),
      );
      yield* seedProject;
      const { issue } = yield* tracker.create({ title: "No provider", projectId: PROJECT }, ACTOR);

      const { run } = yield* tracker.startEnrichment({ issueId: issue.id });
      const finished = yield* awaitFinished(tracker, issue.id, run.id);

      assert.strictEqual(finished.state, "failed");
      assert.include(finished.error ?? "", "not available on PATH");
    }).pipe(Effect.provide(DependenciesLive), TestClock.withLive),
  );

  it.effect("interrupts the provider when a run is cancelled, and frees the slot", () =>
    Effect.gen(function* () {
      const interrupted = yield* Deferred.make<void>();
      const tracker = yield* buildTracker(({ onOutput }) =>
        // Says one thing and then never answers, recording that it was torn down. A real
        // provider's scope finalizer kills its child process by handle at exactly this point.
        (onOutput?.("reading files\n") ?? Effect.void).pipe(
          Effect.andThen(
            Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
          ),
        ),
      );
      yield* seedProject;
      const { issue } = yield* tracker.create({ title: "Cancel me", projectId: PROJECT }, ACTOR);

      const { run } = yield* tracker.startEnrichment({ issueId: issue.id });
      // Long enough for a publish window to elapse. The transcript is a live log: output has to
      // reach the record while the run is still going, not only when it ends.
      yield* Effect.sleep(400);
      const inFlight = (yield* tracker.getEnrichmentRuns({ issueId: issue.id })).runs[0];
      assert.strictEqual(inFlight?.state, "running");
      assert.strictEqual(inFlight?.transcript, "reading files\n");

      const { run: stopped } = yield* tracker.cancelEnrichment({ runId: run.id });
      assert.strictEqual(stopped.state, "failed");
      assert.strictEqual(stopped.error, "Canceled.");
      yield* Deferred.await(interrupted);

      // The permit came back with the interrupt, so the next run is not stuck behind a dead one.
      const { issue: second } = yield* tracker.create(
        { title: "Next in line", projectId: PROJECT },
        ACTOR,
      );
      const { run: nextRun } = yield* tracker.startEnrichment({ issueId: second.id });
      yield* Effect.sleep(50);
      assert.strictEqual(yield* runState(tracker, second.id, nextRun.id), "running");
    }).pipe(Effect.provide(DependenciesLive), TestClock.withLive),
  );

  it.effect("hands the model the images on an issue's comments, newest last, capped", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<{
        readonly imagePaths: ReadonlyArray<string>;
        readonly prompt: string;
      }>({ imagePaths: [], prompt: "" });
      const tracker = yield* buildTracker(({ imagePaths, prompt }) =>
        Ref.set(seen, { imagePaths: imagePaths ?? [], prompt }).pipe(
          Effect.as({ text: encodeAnswer(ANSWER) }),
        ),
      );
      yield* seedProject;
      const { issue } = yield* tracker.create(
        { title: "Only a screenshot", projectId: PROJECT },
        ACTOR,
      );

      // Six images over two comments: one past the cap, and enough to show the order.
      const attachmentIds: Array<ChatAttachmentId> = [];
      for (let index = 0; index < 6; index += 1) {
        const { attachmentId } = yield* tracker.uploadCommentAttachment({
          issueId: issue.id,
          dataUrl: `data:image/png;base64,${PNG_BASE64}`,
        });
        attachmentIds.push(attachmentId);
      }
      yield* tracker.commentCreate(
        {
          issueId: issue.id,
          body: "attached an image in Slack.",
          attachmentIds: attachmentIds.slice(0, 5),
        },
        ACTOR,
      );
      yield* tracker.commentCreate(
        { issueId: issue.id, body: "and one more", attachmentIds: attachmentIds.slice(5) },
        ACTOR,
      );

      const { run } = yield* tracker.startEnrichment({ issueId: issue.id });
      assert.strictEqual((yield* awaitFinished(tracker, issue.id, run.id)).state, "done");

      const { imagePaths, prompt } = yield* Ref.get(seen);
      // The oldest four, in the order the comments were written: a report's own screenshot comes
      // in with it, and the cap must not be the reason it is the one dropped.
      assert.deepStrictEqual(
        imagePaths.map((imagePath) => imagePath.split("/").at(-1)),
        attachmentIds.slice(0, 4).map((attachmentId) => `${attachmentId}.png`),
      );
      // Real files, in the attachment store rather than copies of it.
      for (const imagePath of imagePaths) {
        assert.isTrue(yield* Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(imagePath)));
      }
      assert.include(prompt, "- 4 image attachment(s) from this issue are provided");
      assert.include(prompt, "- 2 more attachment(s) on this issue were not included.");
    }).pipe(Effect.provide(DependenciesLive), TestClock.withLive),
  );

  it.effect("neither sends nor mentions images when the run's provider cannot read one", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<{
        readonly imagePaths: ReadonlyArray<string>;
        readonly prompt: string;
      }>({ imagePaths: ["unset"], prompt: "" });
      const tracker = yield* buildTracker(
        ({ imagePaths, prompt }) =>
          Ref.set(seen, { imagePaths: imagePaths ?? [], prompt }).pipe(
            Effect.as({ text: encodeAnswer(ANSWER) }),
          ),
        // Only the codex driver turns `imagePaths` into anything. Claude drops them silently.
        { enrichmentInstanceId: "claudeAgent" },
      );
      yield* seedProject;
      const { issue } = yield* tracker.create(
        { title: "Only a screenshot", projectId: PROJECT },
        ACTOR,
      );
      const { attachmentId } = yield* tracker.uploadCommentAttachment({
        issueId: issue.id,
        dataUrl: `data:image/png;base64,${PNG_BASE64}`,
      });
      yield* tracker.commentCreate(
        { issueId: issue.id, body: "screenshot", attachmentIds: [attachmentId] },
        ACTOR,
      );

      const { run } = yield* tracker.startEnrichment({ issueId: issue.id });
      assert.strictEqual((yield* awaitFinished(tracker, issue.id, run.id)).state, "done");

      const { imagePaths, prompt } = yield* Ref.get(seen);
      // Nothing sent, and — the part that was a lie before — nothing claimed either. A prompt that
      // says "1 image is provided" to a provider that drops it invites reasoning about evidence
      // the model never saw.
      assert.deepStrictEqual(imagePaths, []);
      assert.notInclude(prompt, "Attachments:");
      assert.notInclude(prompt, "image attachment(s)");
    }).pipe(Effect.provide(DependenciesLive), TestClock.withLive),
  );

  it.effect("skips an image in a format the CLI would refuse, and counts it as omitted", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<{
        readonly imagePaths: ReadonlyArray<string>;
        readonly prompt: string;
      }>({ imagePaths: ["unset"], prompt: "" });
      const tracker = yield* buildTracker(({ imagePaths, prompt }) =>
        Ref.set(seen, { imagePaths: imagePaths ?? [], prompt }).pipe(
          Effect.as({ text: encodeAnswer(ANSWER) }),
        ),
      );
      yield* seedProject;
      const { issue } = yield* tracker.create(
        { title: "Mixed formats", projectId: PROJECT },
        ACTOR,
      );

      // An SVG is safe to render in the panel and fatal to `codex exec --image`, which fails the
      // run rather than skipping the file. One of these must not cost the whole investigation.
      const { attachmentId: svg } = yield* tracker.uploadCommentAttachment({
        issueId: issue.id,
        dataUrl: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64")}`,
      });
      const { attachmentId: png } = yield* tracker.uploadCommentAttachment({
        issueId: issue.id,
        dataUrl: `data:image/png;base64,${PNG_BASE64}`,
      });
      yield* tracker.commentCreate(
        { issueId: issue.id, body: "two files", attachmentIds: [svg, png] },
        ACTOR,
      );

      const { run } = yield* tracker.startEnrichment({ issueId: issue.id });
      assert.strictEqual((yield* awaitFinished(tracker, issue.id, run.id)).state, "done");

      const { imagePaths, prompt } = yield* Ref.get(seen);
      assert.deepStrictEqual(
        imagePaths.map((imagePath) => imagePath.split("/").at(-1)),
        [`${png}.png`],
      );
      // Unsendable is still one the model does not have: counted, so "there is more" stays true.
      assert.include(prompt, "- 1 image attachment(s) from this issue are provided");
      assert.include(prompt, "- 1 more attachment(s) on this issue were not included.");
    }).pipe(Effect.provide(DependenciesLive), TestClock.withLive),
  );

  it.effect("sends no images, and says nothing about them, for an issue that has none", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<{
        readonly imagePaths: ReadonlyArray<string>;
        readonly prompt: string;
      }>({ imagePaths: ["unset"], prompt: "" });
      const tracker = yield* buildTracker(({ imagePaths, prompt }) =>
        Ref.set(seen, { imagePaths: imagePaths ?? [], prompt }).pipe(
          Effect.as({ text: encodeAnswer(ANSWER) }),
        ),
      );
      yield* seedProject;
      const { issue } = yield* tracker.create({ title: "No pictures", projectId: PROJECT }, ACTOR);
      yield* tracker.commentCreate({ issueId: issue.id, body: "Words only." }, ACTOR);

      const { run } = yield* tracker.startEnrichment({ issueId: issue.id });
      assert.strictEqual((yield* awaitFinished(tracker, issue.id, run.id)).state, "done");

      const { imagePaths, prompt } = yield* Ref.get(seen);
      assert.deepStrictEqual(imagePaths, []);
      assert.notInclude(prompt, "Attachments:");
    }).pipe(Effect.provide(DependenciesLive), TestClock.withLive),
  );

  it.effect("runs one investigation at a time and drains the queue in order", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const startedKeys: Array<string> = [];

      const tracker = yield* buildTracker(({ prompt }) =>
        Effect.gen(function* () {
          const key = prompt.includes("Issue ISS-1:") ? "ISS-1" : "ISS-2";
          startedKeys.push(key);
          if (key === "ISS-1") {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(release);
          }
          return { text: encodeAnswer({ ...ANSWER, summary: `Investigated ${key}.` }) };
        }),
      );
      yield* seedProject;
      const { issue: first } = yield* tracker.create({ title: "First", projectId: PROJECT }, ACTOR);
      const { issue: second } = yield* tracker.create(
        { title: "Second", projectId: PROJECT },
        ACTOR,
      );

      const { run: firstRun } = yield* tracker.startEnrichment({ issueId: first.id });
      yield* Deferred.await(firstStarted);
      const { run: secondRun } = yield* tracker.startEnrichment({ issueId: second.id });

      // `queued` is what "behind the one permit" looks like from outside, and the provider has
      // not been asked anything about the second issue yet.
      yield* Effect.sleep(50);
      assert.strictEqual(yield* runState(tracker, second.id, secondRun.id), "queued");
      assert.deepStrictEqual(startedKeys, ["ISS-1"]);

      yield* Deferred.succeed(release, undefined);
      const finishedFirst = yield* awaitFinished(tracker, first.id, firstRun.id);
      const finishedSecond = yield* awaitFinished(tracker, second.id, secondRun.id);

      assert.strictEqual(finishedFirst.state, "done");
      assert.strictEqual(finishedSecond.state, "done");
      assert.strictEqual(finishedSecond.result?.summary, "Investigated ISS-2.");
      assert.deepStrictEqual(startedKeys, ["ISS-1", "ISS-2"]);
    }).pipe(Effect.provide(DependenciesLive), TestClock.withLive),
  );
});

describe("selectInvestigationImages", () => {
  const resolvesEverything = (attachmentId: string) => `/attachments/${attachmentId}.png`;

  it("takes the oldest four and stops resolving there", () => {
    const asked: Array<string> = [];
    const attachmentIds = Array.from({ length: 40 }, (_unused, index) => `image-${index}`);

    const { imagePaths, omitted } = IssueEnrichmentEngineLive.selectInvestigationImages({
      attachmentIds,
      resolveUsableImage: (attachmentId) => {
        asked.push(attachmentId);
        return resolvesEverything(attachmentId);
      },
    });

    assert.deepStrictEqual(imagePaths, [
      "/attachments/image-0.png",
      "/attachments/image-1.png",
      "/attachments/image-2.png",
      "/attachments/image-3.png",
    ]);
    // The point: resolution is a fistful of `existsSync` probes per id, and forty screenshots
    // must not cost forty of them to send four.
    assert.deepStrictEqual(asked, ["image-0", "image-1", "image-2", "image-3"]);
    assert.strictEqual(omitted, 36);
  });

  it("keeps reading past one it cannot use, and counts it as omitted anyway", () => {
    const unusable = new Set(["image-1", "image-5"]);

    const { imagePaths, omitted } = IssueEnrichmentEngineLive.selectInvestigationImages({
      attachmentIds: ["image-0", "image-1", "image-2", "image-3", "image-4", "image-5"],
      resolveUsableImage: (attachmentId) =>
        unusable.has(attachmentId) ? null : resolvesEverything(attachmentId),
    });

    // `image-1` was skipped, not fatal: the cap is four *usable* images, so `image-4` rides along.
    assert.deepStrictEqual(imagePaths, [
      "/attachments/image-0.png",
      "/attachments/image-2.png",
      "/attachments/image-3.png",
      "/attachments/image-4.png",
    ]);
    // Two left behind — one unresolvable, one never reached. Both are images the model does not
    // have, which is the only distinction the prompt can honestly draw.
    assert.strictEqual(omitted, 2);
  });

  it("omits nothing when the issue has nothing to omit", () => {
    assert.deepStrictEqual(
      IssueEnrichmentEngineLive.selectInvestigationImages({
        attachmentIds: [],
        resolveUsableImage: resolvesEverything,
      }),
      { imagePaths: [], omitted: 0 },
    );
    assert.deepStrictEqual(
      IssueEnrichmentEngineLive.selectInvestigationImages({
        attachmentIds: ["image-0"],
        resolveUsableImage: resolvesEverything,
      }),
      { imagePaths: ["/attachments/image-0.png"], omitted: 0 },
    );
  });
});
