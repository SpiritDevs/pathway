/**
 * The live {@link IssueCommentAgentEngine}: the process half of a mentioned agent's run.
 *
 * `IssueTrackerService` owns the record — it writes the comment and its `queued` run together, and
 * republishes the comment on every transition. This layer owns everything else: gathering the issue
 * and its thread, running the mentioned provider read-only in the project's directory, streaming
 * what it says into the run's transcript, and turning its last message into a reply.
 *
 * The three shapes are enrichment's, deliberately — see `IssueEnrichmentEngineLive.ts` for the long
 * version:
 *
 * - **One run at a time, server-wide.** A permit, not a scheduler. A second mention leaves its run
 *   `queued` and blocks until the first finishes, which is why `markRunning` is called after the
 *   permit is taken rather than when the fiber starts.
 *
 * - **Cancellation is fiber interruption.** Every run's working fiber is registered by id, and
 *   `cancel` interrupts it. Interruption closes the scope the provider spawned its child on, whose
 *   finalizer kills that child by handle.
 *
 * - **The engine never touches `IssueTrackerService`.** It reports through the recorder it was
 *   handed, which is what keeps the two layers acyclic.
 *
 * One permit is shared with nothing: enrichment has its own, so an investigation and a mentioned
 * agent can run at once. That is the same policy at a coarser grain — a person who mentions an
 * agent while an investigation is grinding expects an answer, not a queue behind a robot.
 *
 * @module issues/IssueCommentAgentEngineLive
 */
import {
  ISSUE_COMMENT_AGENT_RUN_TRANSCRIPT_PUBLISH_INTERVAL_MS,
  IssueTrackerError,
  type IssueActor,
  type IssueCommentAgentRunId,
  type IssueCommentAgentRunPhase,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import { IssueCommentRepository } from "../persistence/Services/IssueComments.ts";
import { IssueLabelRepository } from "../persistence/Services/IssueLabels.ts";
import { IssueStatusRepository } from "../persistence/Services/IssueStatuses.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  IssueCommentAgentEngine,
  type IssueCommentAgentEngineShape,
  type IssueCommentAgentRunRecorder,
  type IssueCommentAgentStartRequest,
} from "./IssueCommentAgentEngine.ts";
import {
  buildCommentAgentPrompt,
  nextCommentAgentPhase,
  parseCommentAgentAnswer,
  type CommentAgentThreadEntry,
} from "./commentAgent.ts";

const invalid = (message: string) => new IssueTrackerError({ reason: "invalid", message });
const storage = (message: string) => new IssueTrackerError({ reason: "storage", message });

/** How a comment is attributed in the prompt. The tracker has no names, only kinds. */
function describeActor(actor: IssueActor): string {
  switch (actor.kind) {
    case "user":
      return "The human";
    case "agent":
      return `Agent (${actor.provider})`;
    case "system":
      return `System (${actor.source})`;
  }
}

export const make = Effect.gen(function* () {
  const textGeneration = yield* TextGeneration.TextGeneration;
  const providers = yield* ProviderInstanceRegistry;
  const statusRepository = yield* IssueStatusRepository;
  const labelRepository = yield* IssueLabelRepository;
  const commentRepository = yield* IssueCommentRepository;
  const projectRepository = yield* ProjectionProjectRepository;

  const slot = yield* Semaphore.make(1);
  const runningFibers = yield* Ref.make(new Map<IssueCommentAgentRunId, Fiber.Fiber<void>>());

  const read = <A>(
    message: string,
    effect: Effect.Effect<A, { readonly message: string }>,
  ): Effect.Effect<A, IssueTrackerError> => effect.pipe(Effect.mapError(() => storage(message)));

  /**
   * Everything the model is told, read in one pass from the repositories directly — this layer
   * cannot depend on `IssueTrackerService` without the two requiring each other. All reads.
   */
  const gatherContext = Effect.fn("IssueCommentAgentEngine.gatherContext")(function* (
    request: IssueCommentAgentStartRequest,
  ) {
    const { issue } = request;
    const [statuses, labels, comments] = yield* Effect.all(
      [
        read("Failed to read the issue statuses", statusRepository.listAll()),
        read("Failed to read the issue labels", labelRepository.listAll()),
        read(
          "Failed to read the issue comments",
          commentRepository.listByIssue({ issueId: issue.id }),
        ),
      ],
      { concurrency: "unbounded" },
    );

    const project =
      issue.projectId === null
        ? Option.none()
        : yield* read(
            "Failed to read the project",
            projectRepository.getById({ projectId: issue.projectId }),
          );

    const labelNames = new Map(labels.map((label) => [label.id, label.name as string] as const));
    // The thread up to and including the ask. Anything posted after the mention is a race — a
    // second person typing while the run started — and answering it was never what was asked.
    const askIndex = comments.findIndex((comment) => comment.id === request.comment.id);
    const upToAsk = askIndex === -1 ? comments : comments.slice(0, askIndex + 1);
    const thread: ReadonlyArray<CommentAgentThreadEntry> = upToAsk.map((comment) => ({
      author: describeActor(comment.author),
      body: comment.body,
      isAsk: comment.id === request.comment.id,
    }));

    return buildCommentAgentPrompt({
      key: issue.key,
      title: issue.title,
      description: issue.description,
      statusName: statuses.find((status) => status.id === issue.statusId)?.name ?? "(unknown)",
      priority: issue.priority,
      labelNames: issue.labelIds.flatMap((labelId) => {
        const name = labelNames.get(labelId);
        return name === undefined ? [] : [name];
      }),
      projectName: Option.isSome(project) ? project.value.title : null,
      thread,
    });
  });

  /**
   * A transcript pump: buffer everything the provider says, hand it to the recorder on a timer.
   *
   * Every append rewrites the comment and republishes it, and a model emits tokens far faster than
   * a panel can paint them. The contract names the window
   * ({@link ISSUE_COMMENT_AGENT_RUN_TRANSCRIPT_PUBLISH_INTERVAL_MS}) and leaves the batching here.
   */
  const withTranscriptPump = Effect.fn("IssueCommentAgentEngine.withTranscriptPump")(function* <A>(
    recorder: IssueCommentAgentRunRecorder,
    body: (onOutput: (chunk: string) => Effect.Effect<void>) => Effect.Effect<A, IssueTrackerError>,
  ) {
    const buffer = yield* Ref.make("");
    const phase = yield* Ref.make<IssueCommentAgentRunPhase>("thinking");
    // A failed append must not take the run down with it: the transcript is a log, and losing a
    // window of it is not a reason to throw away the investigation that produced it.
    const flush = Ref.getAndSet(buffer, "").pipe(
      Effect.flatMap((pending) =>
        pending.length === 0 ? Effect.void : recorder.appendTranscript(pending),
      ),
      Effect.ignoreCause({ log: true }),
    );
    const pump = yield* Effect.forkChild(
      Effect.sleep(ISSUE_COMMENT_AGENT_RUN_TRANSCRIPT_PUBLISH_INTERVAL_MS).pipe(
        Effect.andThen(flush),
        Effect.forever,
      ),
    );

    // The phase is published as it changes rather than on the pump's timer: it changes at most
    // twice in a run, and a word under a spinner that is a quarter-second stale reads as a stall.
    const onOutput = (chunk: string) =>
      Ref.update(buffer, (current) => current + chunk).pipe(
        Effect.andThen(
          Ref.modify(phase, (current) => {
            const next = nextCommentAgentPhase(current, chunk);
            return [next === current ? null : next, next] as const;
          }),
        ),
        Effect.flatMap((changed) =>
          changed === null ? Effect.void : recorder.setPhase(changed).pipe(Effect.ignoreCause()),
        ),
      );

    return yield* body(onOutput).pipe(
      // The last window lands even when the body failed: what the process printed on its way to
      // failing is usually the only explanation there is.
      Effect.ensuring(Fiber.interrupt(pump).pipe(Effect.andThen(flush))),
    );
  });

  const runAgent = Effect.fn("IssueCommentAgentEngine.runAgent")(function* (
    request: IssueCommentAgentStartRequest,
  ) {
    const { recorder, run } = request;
    const prompt = yield* gatherContext(request);

    // Everything above this line is cheap and local; the permit is taken only for the part that
    // spends money and CPU. Queued runs wait here, and the run stays `queued` while they do.
    yield* slot.withPermits(1)(
      Effect.gen(function* () {
        yield* recorder.markRunning;
        yield* recorder.setPhase("thinking");

        const generated = yield* withTranscriptPump(recorder, (onOutput) =>
          textGeneration
            .investigate({
              cwd: request.workspaceRoot,
              prompt,
              onOutput,
              modelSelection: run.mention.modelSelection,
            })
            .pipe(
              Effect.mapError((cause) => invalid(`The agent could not be run: ${cause.detail}`)),
            ),
        );

        // Whatever the heuristic made of the transcript, assembling the answer is `replying`.
        yield* recorder.setPhase("replying");
        yield* recorder.succeed(parseCommentAgentAnswer(generated.text));
      }),
    );
  });

  /**
   * Report a failure the run's own fiber could not.
   *
   * Safe to call after a cancellation: the tracker's terminal write reads first, so a run already
   * marked canceled keeps that.
   */
  const recorderFail = (request: IssueCommentAgentStartRequest, message: string) =>
    request.recorder.fail(message).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to record a comment agent failure", {
          runId: request.run.id,
          message,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const start: IssueCommentAgentEngineShape["start"] = Effect.fn("IssueCommentAgentEngine.start")(
    function* (request) {
      // Forked and registered before anything else so a cancel that arrives while the run is still
      // queued behind another one has something to interrupt.
      const fiber = yield* Effect.forkChild(
        runAgent(request).pipe(
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

  const cancel: IssueCommentAgentEngineShape["cancel"] = Effect.fn(
    "IssueCommentAgentEngine.cancel",
  )(function* (input) {
    const fiber = (yield* Ref.get(runningFibers)).get(input.runId);
    // Unknown or already finished is a no-op, not an error: the record is what says a run is
    // canceled, and the tracker has already written that by the time this is reached.
    if (fiber === undefined) return;
    yield* Fiber.interrupt(fiber);
  });

  const resolveMention: IssueCommentAgentEngineShape["resolveMention"] = ({ modelSelection }) =>
    providers.getInstance(modelSelection.instanceId).pipe(
      Effect.flatMap((instance) =>
        instance === undefined
          ? Effect.fail(
              invalid(`There is no provider instance named ${modelSelection.instanceId}.`),
            )
          : Effect.succeed({
              kind: "agent" as const,
              // Resolved from the instance, never asserted by the client: the comment says which
              // agent answered, and it has to be the one that actually ran.
              provider: instance.driverKind,
              modelSelection,
            }),
      ),
    );

  return { resolveMention, start, cancel } satisfies IssueCommentAgentEngineShape;
});

export const layer = Layer.effect(IssueCommentAgentEngine, make);
