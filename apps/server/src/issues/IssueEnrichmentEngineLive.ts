/**
 * The live {@link IssueEnrichmentEngine}: the process half of an enrichment run.
 *
 * `IssueTrackerService` owns the record — it validates the request, writes the queued row, and
 * turns every transition into an `EnrichmentRunChanged` event. This layer owns everything else:
 * gathering what the model should know, running the configured provider read-only in the
 * project's directory, streaming what it says into the run's transcript, and turning its final
 * message into a structured result.
 *
 * Three shapes worth knowing before reading:
 *
 * - **One run at a time, server-wide.** A permit, not a scheduler. A second Investigate press
 *   leaves its row `queued` and blocks on the semaphore until the first finishes, which is why
 *   `markRunning` is called after the permit is taken rather than when the fiber starts. Effect's
 *   semaphore hands permits out in request order, so the queue drains FIFO for free. The reason is
 *   plain: this is a laptop, and two coding agents reading the same tree is two fans at once.
 *
 * - **Cancellation is fiber interruption.** Every run's working fiber is registered by id, and
 *   `cancel` interrupts it. Interruption closes the scope the provider spawned its child on, whose
 *   finalizer kills that child *by handle*. Nothing here ever matches a process by name.
 *
 * - **The engine never touches `IssueTrackerService`.** It reports through the recorder it was
 *   handed. That is what keeps the two layers acyclic; see `IssueEnrichmentEngine.ts`.
 *
 * @module issues/IssueEnrichmentEngineLive
 */
import {
  ISSUE_ENRICHMENT_TRANSCRIPT_PUBLISH_INTERVAL_MS,
  IssueTrackerError,
  type Issue,
  type IssueActor,
  type IssueEnrichmentRun,
  type IssueEnrichmentRunId,
  type IssueLabel,
  type IssueStatus,
} from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { IssueCommentRepository } from "../persistence/Services/IssueComments.ts";
import { IssueLabelRepository } from "../persistence/Services/IssueLabels.ts";
import { IssueRelationRepository } from "../persistence/Services/IssueRelations.ts";
import { IssueRepository, type IssueRecord } from "../persistence/Services/Issues.ts";
import { IssueStatusRepository } from "../persistence/Services/IssueStatuses.ts";
import { IssueTodoRepository } from "../persistence/Services/IssueTodos.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  IssueEnrichmentEngine,
  type IssueEnrichmentEngineShape,
  type IssueEnrichmentRunRecorder,
  type IssueEnrichmentStartRequest,
} from "./IssueEnrichmentEngine.ts";
import {
  buildInvestigationPrompt,
  extractLastJsonObject,
  investigationErrorTail,
  normalizeInvestigationResult,
  type InvestigationComment,
  type InvestigationRelation,
} from "./enrichment.ts";

/** A status whose category means the issue is still live, and so worth offering as related. */
const OPEN_STATUS_CATEGORIES: ReadonlySet<IssueStatus["category"]> = new Set([
  "backlog",
  "unstarted",
  "started",
]);

/**
 * How many of an issue's images the investigation is handed.
 *
 * A ceiling rather than the lot: every image is another few thousand tokens of context on a
 * request that already carries the repository, and an issue with a dozen screenshots said what it
 * had to say in the first few. The oldest are kept — a report's own screenshot arrives with it,
 * and what follows is usually somebody else's aside.
 */
const MAX_INVESTIGATION_IMAGES = 4;

/**
 * The image formats an investigation may hand a provider.
 *
 * Narrower than `SAFE_IMAGE_FILE_EXTENSIONS` in `imageMime.ts`, which answers a different question
 * — what is safe to serve a browser. This one answers what a CLI will actually decode:
 * `codex exec --image` rejects a format it does not know rather than skipping the file, so one
 * HEIC or SVG pasted into a comment would fail the whole investigation. These four formats are
 * what a provider that takes an image at all takes.
 */
const INVESTIGATION_IMAGE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png",
  ".jpeg",
  ".jpg",
  ".webp",
  ".gif",
]);

/**
 * Pick the images an investigation sends, and count what it leaves behind.
 *
 * Resolution stops at the cap rather than resolving everything and slicing: `resolveUsableImage`
 * is a handful of `existsSync` probes per id, and an issue with forty screenshots would pay for
 * all forty to send four. `omitted` is therefore counted, not resolved — every candidate that did
 * not become one of the sent paths, whether it was over the cap, in a format no provider reads, or
 * missing from the store entirely. A number the prompt can state honestly without knowing why.
 *
 * Pure, and exported, so the early stop is a test rather than a comment.
 */
export function selectInvestigationImages(input: {
  /** Every image-candidate attachment id on the issue, oldest first. */
  readonly attachmentIds: ReadonlyArray<string>;
  /** The path this id's bytes are at, or null if there is nothing usable behind it. */
  readonly resolveUsableImage: (attachmentId: string) => string | null;
}): { readonly imagePaths: ReadonlyArray<string>; readonly omitted: number } {
  const imagePaths: Array<string> = [];
  for (const attachmentId of input.attachmentIds) {
    if (imagePaths.length >= MAX_INVESTIGATION_IMAGES) break;
    const resolved = input.resolveUsableImage(attachmentId);
    if (resolved === null) continue;
    imagePaths.push(resolved);
  }
  return { imagePaths, omitted: input.attachmentIds.length - imagePaths.length };
}

const invalid = (message: string) => new IssueTrackerError({ reason: "invalid", message });
const storage = (message: string) => new IssueTrackerError({ reason: "storage", message });

/** How a comment is attributed in the prompt. The tracker has no names, only kinds. */
function describeActor(actor: IssueActor): string {
  switch (actor.kind) {
    // A member is a person too, and carries a membership id rather than a name, so there is nothing
    // to say about them that "the human" does not already say.
    case "user":
    case "member":
      return "The human";
    case "agent":
      return `Agent (${actor.provider})`;
    case "system":
      return `System (${actor.source})`;
  }
}

export const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const providers = yield* ProviderInstanceRegistry;
  const issueRepository = yield* IssueRepository;
  const statusRepository = yield* IssueStatusRepository;
  const labelRepository = yield* IssueLabelRepository;
  const todoRepository = yield* IssueTodoRepository;
  const relationRepository = yield* IssueRelationRepository;
  const commentRepository = yield* IssueCommentRepository;

  // One permit for the whole server. See the module note: this is the concurrency policy, and
  // the FIFO ordering of its waiters is the queue.
  const slot = yield* Semaphore.make(1);
  const runningFibers = yield* Ref.make(new Map<IssueEnrichmentRunId, Fiber.Fiber<void>>());

  const read = <A>(
    message: string,
    effect: Effect.Effect<A, { readonly message: string }>,
  ): Effect.Effect<A, IssueTrackerError> => effect.pipe(Effect.mapError(() => storage(message)));

  /**
   * The file one comment attachment id stands for, if an investigation can send it.
   *
   * A comment stores ids, not paths: the bytes are in the attachment store that threads share,
   * under a name the store derives from the media type it was uploaded with. Only an image can be
   * uploaded to an issue in the first place, and anything that resolves to a format the CLIs do
   * not decode is dropped here — this feeds `--image`, which is for pictures of four kinds.
   */
  const resolveUsableImage = (attachmentId: string): string | null => {
    const resolved = resolveAttachmentPathById({
      attachmentsDir: serverConfig.attachmentsDir,
      attachmentId,
    });
    if (resolved === null) return null;
    return INVESTIGATION_IMAGE_FILE_EXTENSIONS.has(path.extname(resolved).toLowerCase())
      ? resolved
      : null;
  };

  /**
   * Whether the provider this run is pinned to can be handed an image at all.
   *
   * Asked of the instance rather than of the setting: a selection naming a disabled provider falls
   * back to an enabled one (`resolveIssueEnrichmentProvider`), so the configured provider is not
   * always the provider that runs. An unknown instance answers no — `investigate` is about to fail
   * on it anyway, and "no" is the answer that cannot lie to the model.
   */
  const investigationImagesSupported = (modelSelection: IssueEnrichmentRun["modelSelection"]) =>
    providers
      .getInstance(modelSelection.instanceId)
      .pipe(
        Effect.map(
          (instance) =>
            instance !== undefined &&
            TextGeneration.supportsInvestigationImages(instance.driverKind),
        ),
      );

  /**
   * Everything the model is told, read in one pass.
   *
   * From the repositories directly rather than through `IssueTrackerService`, which this layer
   * cannot depend on without the two requiring each other. These are all reads of tables the
   * tracker owns; nothing here writes.
   *
   * `imagesSupported` decides whether the issue's pictures are read at all. A provider that cannot
   * take an image must not be told it was given four, so the collection and the prompt's
   * Attachments section are one decision, made here, before either happens.
   */
  const gatherContext = Effect.fn("IssueEnrichmentEngine.gatherContext")(function* (
    issue: Issue,
    options: { readonly imagesSupported: boolean },
  ) {
    const [statuses, labels, records, todos, relations, comments] = yield* Effect.all(
      [
        read("Failed to read the issue statuses", statusRepository.listAll()),
        read("Failed to read the issue labels", labelRepository.listAll()),
        read("Failed to read the issues", issueRepository.listLive()),
        read("Failed to read the issue todos", todoRepository.listByIssue({ issueId: issue.id })),
        read(
          "Failed to read the issue relations",
          relationRepository.listByIssue({ issueId: issue.id }),
        ),
        read(
          "Failed to read the issue comments",
          commentRepository.listByIssue({ issueId: issue.id }),
        ),
      ],
      { concurrency: "unbounded" },
    );

    const statusById = new Map(statuses.map((status) => [status.id, status] as const));
    const labelById = new Map<IssueLabel["id"], IssueLabel>(
      labels.map((label) => [label.id, label] as const),
    );
    const recordById = new Map<IssueRecord["id"], IssueRecord>(
      records.map((record) => [record.id, record] as const),
    );

    // Open, not deleted, and not this issue: the set the model may name as related. A triage item
    // is included — it has no status yet, and "related to something nobody has sorted" is exactly
    // the connection worth surfacing.
    const openIssues = records
      .filter((record) => {
        if (record.id === issue.id) return false;
        const category = statusById.get(record.statusId)?.category;
        return record.triage || (category !== undefined && OPEN_STATUS_CATEGORIES.has(category));
      })
      .map((record) => ({ key: record.key as string, title: record.title }));

    const investigationRelations: Array<InvestigationRelation> = [];
    for (const edge of relations) {
      const otherId =
        edge.direction === "outgoing" ? edge.relation.relatedIssueId : edge.relation.issueId;
      const other = recordById.get(otherId);
      if (other === undefined) continue;
      investigationRelations.push({
        kind: edge.relation.kind,
        direction: edge.direction,
        key: other.key,
        title: other.title,
      });
    }

    const investigationComments: ReadonlyArray<InvestigationComment> = comments.map((comment) => ({
      author: describeActor(comment.author),
      body: comment.body,
    }));

    // A Slack report that is nothing but a screenshot puts its one useful fact on a comment
    // attachment, so an investigation that never sees those is reading around the bug. Skipped
    // entirely for a provider with no way to accept one: unread bytes cost disk probes here and a
    // sentence of untruth in the prompt.
    const attachmentIds: Array<string> = [];
    if (options.imagesSupported) {
      const seenAttachmentIds = new Set<string>();
      for (const comment of comments) {
        for (const attachmentId of comment.attachmentIds) {
          if (seenAttachmentIds.has(attachmentId)) continue;
          seenAttachmentIds.add(attachmentId);
          attachmentIds.push(attachmentId);
        }
      }
    }
    const { imagePaths, omitted } = selectInvestigationImages({
      attachmentIds,
      resolveUsableImage,
    });

    return {
      imagePaths,
      prompt: buildInvestigationPrompt({
        key: issue.key,
        title: issue.title,
        description: issue.description,
        slackIngested: issue.slackSource !== null,
        statusName: statusById.get(issue.statusId)?.name ?? "(unknown)",
        priority: issue.priority,
        labelNames: issue.labelIds.flatMap((labelId) => {
          const label = labelById.get(labelId);
          return label ? [label.name as string] : [];
        }),
        todos: todos.map((todo) => ({ text: todo.text, done: todo.done })),
        relations: investigationRelations,
        comments: investigationComments,
        images: { provided: imagePaths.length, omitted },
        availableLabels: labels.map((label) => label.name as string),
        openIssues,
      }),
      knownIssueKeys: new Set(openIssues.map((entry) => entry.key)),
      knownLabels: labels.map((label) => label.name as string),
    };
  });

  /**
   * A transcript pump: buffer everything the provider says, hand it to the recorder on a timer.
   *
   * Every append rewrites the run row and republishes the whole run, and a model emits tokens far
   * faster than a panel can paint them. The contract names the window
   * ({@link ISSUE_ENRICHMENT_TRANSCRIPT_PUBLISH_INTERVAL_MS}) and leaves the batching here,
   * because the service cannot know how chatty its caller is.
   */
  const withTranscriptPump = Effect.fn("IssueEnrichmentEngine.withTranscriptPump")(function* <A>(
    recorder: IssueEnrichmentRunRecorder,
    body: (onOutput: (chunk: string) => Effect.Effect<void>) => Effect.Effect<A, IssueTrackerError>,
  ) {
    const buffer = yield* Ref.make("");
    // A failed append must not take the run down with it: the transcript is a log, and losing a
    // window of it is not a reason to throw away the investigation that produced it.
    const flush = Ref.getAndSet(buffer, "").pipe(
      Effect.flatMap((pending) =>
        pending.length === 0 ? Effect.void : recorder.appendTranscript(pending),
      ),
      Effect.ignoreCause({ log: true }),
    );
    const pump = yield* Effect.forkChild(
      Effect.sleep(ISSUE_ENRICHMENT_TRANSCRIPT_PUBLISH_INTERVAL_MS).pipe(
        Effect.andThen(flush),
        Effect.forever,
      ),
    );

    return yield* body((chunk) => Ref.update(buffer, (current) => current + chunk)).pipe(
      // The last window lands even when the body failed: what the process printed on its way to
      // failing is usually the only explanation there is.
      Effect.ensuring(Fiber.interrupt(pump).pipe(Effect.andThen(flush))),
    );
  });

  const runInvestigation = Effect.fn("IssueEnrichmentEngine.runInvestigation")(function* (
    request: IssueEnrichmentStartRequest,
  ) {
    const { recorder, run } = request;
    const imagesSupported = yield* investigationImagesSupported(run.modelSelection);
    const context = yield* gatherContext(request.issue, { imagesSupported });

    // Everything above this line is cheap and local; the permit is taken only for the part that
    // spends money and CPU. Queued runs wait here, and the row stays `queued` while they do.
    yield* slot.withPermits(1)(
      Effect.gen(function* () {
        yield* recorder.markRunning;

        const generated = yield* withTranscriptPump(recorder, (onOutput) =>
          textGeneration
            .investigate({
              cwd: request.workspaceRoot,
              prompt: context.prompt,
              onOutput,
              imagePaths: context.imagePaths,
              modelSelection: run.modelSelection,
            })
            .pipe(
              Effect.mapError((cause) =>
                invalid(`The investigation could not be run: ${cause.detail}`),
              ),
            ),
        );

        const json = extractLastJsonObject(generated.text);
        const parsed = json === null ? null : parseJsonOrNull(json);
        const result =
          parsed === null
            ? null
            : normalizeInvestigationResult(parsed, {
                knownIssueKeys: context.knownIssueKeys,
                knownLabels: context.knownLabels,
                currentTitle: request.issue.title,
                currentDescription: request.issue.description,
              });

        if (result === null) {
          // The tail rather than a bare "invalid output": this is the only place a human can see
          // what the model actually said, and "it did not answer in JSON" is not a diagnosis.
          return yield* recorder.fail(
            `The investigation did not return a usable result. It ended with:\n\n${investigationErrorTail(generated.text)}`,
          );
        }

        yield* recorder.succeed(result);
      }),
    );
  });

  const start: IssueEnrichmentEngineShape["start"] = Effect.fn("IssueEnrichmentEngine.start")(
    function* (request) {
      // Forked and registered before anything else so a cancel that arrives while the run is still
      // queued behind another one has something to interrupt.
      const fiber = yield* Effect.forkChild(
        runInvestigation(request).pipe(
          Effect.catch((error: IssueTrackerError) => recorderFail(request, error.message)),
          Effect.ignoreCause({ log: true }),
        ),
      );
      yield* Ref.update(runningFibers, (current) => new Map(current).set(request.run.id, fiber));

      yield* Fiber.await(fiber).pipe(
        Effect.ensuring(
          Ref.update(runningFibers, (current) => {
            const next = new Map(current);
            next.delete(request.run.id);
            return next;
          }),
        ),
      );
    },
  );

  /**
   * Report a failure the run's own fiber could not.
   *
   * Safe to call after a cancellation: the tracker's terminal write reads first, so a run already
   * marked failed keeps the reason it was cancelled with.
   */
  const recorderFail = (request: IssueEnrichmentStartRequest, message: string) =>
    request.recorder.fail(message).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to record an enrichment failure", {
          runId: request.run.id,
          message,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const cancel: IssueEnrichmentEngineShape["cancel"] = Effect.fn("IssueEnrichmentEngine.cancel")(
    function* (input) {
      const fiber = (yield* Ref.get(runningFibers)).get(input.runId);
      // Unknown or already finished is a no-op, not an error: the record is what says a run is
      // cancelled, and the tracker has already written that by the time this is reached.
      if (fiber === undefined) return;
      // Interrupting closes the provider's scope, whose finalizer kills the spawned child by
      // handle. The permit it was holding is released by the same unwind, so the next queued run
      // starts immediately.
      yield* Fiber.interrupt(fiber);
    },
  );

  return {
    resolveModelSelection: settings.getSettings.pipe(
      Effect.map((current) => current.issueEnrichmentModelSelection),
      Effect.mapError(() => storage("Failed to read the enrichment model from server settings")),
    ),
    start,
    cancel,
  } satisfies IssueEnrichmentEngineShape;
});

/** `JSON.parse`, without the throw. The input is already known to be a balanced object. */
function parseJsonOrNull(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

export const layer = Layer.effect(IssueEnrichmentEngine, make);
