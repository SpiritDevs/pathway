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
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  IssueEnrichmentResult,
  ProjectId,
  ProviderDriverKind,
  TextGenerationError,
  type IssueActor,
  type IssueEnrichmentRunId,
  type IssueId,
} from "@t3tools/contracts";

import * as NodeServices from "@effect/platform-node/NodeServices";

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
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as IssueEnrichmentEngineLive from "./IssueEnrichmentEngineLive.ts";
import { IssueTrackerService, layer as issueTrackerLayer } from "./IssueTrackerService.ts";

const ACTOR: IssueActor = { kind: "user" };
const PROJECT = ProjectId.make("project-alpha");
const WORKSPACE_ROOT = "/tmp/pathway";

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
  ProjectionProjectRepositoryLive,
).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-enrichment-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

/**
 * The real tracker over the real engine, built on the database already in context. Only the
 * provider is faked, and the settings are the defaults — which is what pins the run's model to
 * `codex` and makes the agent actor on the description edit predictable.
 */
const buildTracker = (investigate: Investigate) =>
  Effect.provide(
    Effect.gen(function* () {
      return yield* IssueTrackerService;
    }),
    issueTrackerLayer.pipe(
      Layer.provide(
        IssueEnrichmentEngineLive.layer.pipe(
          Layer.provide(
            Layer.succeed(TextGeneration.TextGeneration, makeFakeTextGeneration(investigate)),
          ),
          Layer.provide(serverSettingsLayerTest()),
        ),
      ),
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
  it.effect("streams the transcript, records the result, and appends it to the description", () =>
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
      assert.isTrue(updated.description.startsWith("Body.\n\n---\n\n## Investigation ("));
      assert.include(updated.description, "- `apps/server/src/ws.ts` — Owns reconnect");
      assert.include(updated.description, "**Suggested** (not applied)");
      // Suggestions are suggestions: the run applied neither the label nor the priority.
      assert.deepStrictEqual(updated.labelIds, []);
      assert.strictEqual(updated.priority, "none");

      // And it went through the ordinary update path, so the feed says which agent wrote it.
      const { events } = yield* tracker.getEvents({ issueId: issue.id });
      const descriptionChange = events.find((event) => event.field === "description");
      assert.deepStrictEqual(descriptionChange?.actor, {
        kind: "agent",
        provider: ProviderDriverKind.make("codex"),
      });
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
