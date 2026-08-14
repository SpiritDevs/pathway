import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ChatAttachment, ModelSelection, ProviderInstanceId } from "@spiritdevs/contracts";
import { ProviderDriverKind, TextGenerationError } from "@spiritdevs/contracts";

import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { TextGenerationPolicy } from "./TextGenerationPolicy.ts";

export type TextGenerationProvider = "codex" | "claudeAgent" | "cursor" | "grok" | "opencode";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** Only present when `includeBranch` was set on the input. */
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  changeRequestTemplate?: string | undefined;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  cwd: string;
  message: string;
  /** Present when replacing an existing title from the current thread history. */
  previousTitle?: string | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
}

/**
 * A read-only one-shot investigation of the repository at `cwd`.
 *
 * The odd one out in this module, and deliberately so. The other four operations hand the provider
 * a JSON schema and take a decoded struct back; this one takes the model's raw final text and
 * leaves parsing to the caller. Two reasons: the answer is long enough that a schema failure would
 * throw away minutes of work rather than seconds, and the caller (issue enrichment) already has to
 * be tolerant of fenced and chatty output because the transcript is shown to a human either way.
 *
 * It is also the only operation with a live audience — a run panel renders the output as it
 * arrives — hence `onOutput`.
 */
export interface InvestigationGenerationInput {
  cwd: string;
  /** The whole instruction set. Built by the caller: this module knows nothing about issues. */
  prompt: string;
  /**
   * Raw provider output, handed over as it arrives, in whatever sizes the transport produces.
   *
   * Not throttled here. The caller batches, because only the caller knows what it is feeding —
   * a database row that republishes on every write, in enrichment's case.
   */
  onOutput?: ((chunk: string) => Effect.Effect<void>) | undefined;
  /**
   * Images to hand the model with the prompt, as absolute paths to files on this machine.
   *
   * Paths rather than bytes: an issue's images are already files in the server's attachment store,
   * and the providers here are CLIs on the same host that take an image by name. Only supply these
   * to a provider that reads them — {@link supportsInvestigationImages} says which do. A provider
   * without the capability ignores them rather than failing, but a caller that sends them anyway
   * has also told the model in its prompt about pictures no model will ever see.
   */
  imagePaths?: ReadonlyArray<string> | undefined;
  /** What model and provider to use for the investigation. */
  modelSelection: ModelSelection;
}

/**
 * The drivers whose `investigate` actually puts an image in front of the model.
 *
 * A capability rather than a hope: every implementation here accepts `imagePaths` on the input
 * because they share one interface, but only Codex turns them into anything (`--image` per file).
 * The others drop them silently, which is harmless until the caller has also written "4 images are
 * provided with this request" into the prompt — at which point the model is being lied to about
 * evidence it cannot see. Callers that build such a sentence must gate it on this.
 *
 * Kept as a list of driver kinds, not a flag on `TextGenerationShape`: the shape is one interface
 * shared by five drivers, and the thing that differs between them is which driver it is.
 */
const INVESTIGATION_IMAGE_DRIVER_KINDS: ReadonlySet<string> = new Set<ProviderDriverKind>([
  ProviderDriverKind.make("codex"),
]);

/** Whether `investigate` on this driver reads the `imagePaths` it is handed. */
export function supportsInvestigationImages(driverKind: ProviderDriverKind): boolean {
  return INVESTIGATION_IMAGE_DRIVER_KINDS.has(driverKind);
}

export interface InvestigationGenerationResult {
  /** The model's final message, unparsed. Empty output is a failure, not an empty result. */
  text: string;
}

export interface TextGenerationService {
  generateCommitMessage(
    input: CommitMessageGenerationInput,
  ): Promise<CommitMessageGenerationResult>;
  generatePrContent(input: PrContentGenerationInput): Promise<PrContentGenerationResult>;
  generateBranchName(input: BranchNameGenerationInput): Promise<BranchNameGenerationResult>;
  generateThreadTitle(input: ThreadTitleGenerationInput): Promise<ThreadTitleGenerationResult>;
  investigate(input: InvestigationGenerationInput): Promise<InvestigationGenerationResult>;
}

/**
 * TextGeneration - Service tag for commit and change request text generation.
 */
export class TextGeneration extends Context.Service<
  TextGeneration,
  {
    /**
     * Generate a commit message from staged change context.
     */
    readonly generateCommitMessage: (
      input: CommitMessageGenerationInput,
    ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

    /**
     * Generate change request title/body from branch and diff context.
     */
    readonly generatePrContent: (
      input: PrContentGenerationInput,
    ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

    /**
     * Generate a concise branch name from a user message.
     */
    readonly generateBranchName: (
      input: BranchNameGenerationInput,
    ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

    /** Generate a concise thread title from a first message or thread history. */
    readonly generateThreadTitle: (
      input: ThreadTitleGenerationInput,
    ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

    /**
     * Investigate the repository at `cwd`, read-only, and return the model's final text.
     *
     * Interrupting this kills the underlying process or session: every implementation registers
     * its child on the enclosing scope, which is how enrichment cancels a run without ever
     * pattern-matching a process list.
     */
    readonly investigate: (
      input: InvestigationGenerationInput,
    ) => Effect.Effect<InvestigationGenerationResult, TextGenerationError>;
  }
>()("@spiritdevs/pathway/textGeneration/TextGeneration") {}

/** @deprecated Use `TextGeneration["Service"]`. */
export type TextGenerationShape = TextGeneration["Service"];

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "investigate";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
): TextGeneration["Service"] =>
  TextGeneration.of({
    generateCommitMessage: (input) =>
      resolveInstance(registry, "generateCommitMessage", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateCommitMessage(input)),
      ),
    generatePrContent: (input) =>
      resolveInstance(registry, "generatePrContent", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generatePrContent(input)),
      ),
    generateBranchName: (input) =>
      resolveInstance(registry, "generateBranchName", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateBranchName(input)),
      ),
    generateThreadTitle: (input) =>
      resolveInstance(registry, "generateThreadTitle", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateThreadTitle(input)),
      ),
    investigate: (input) =>
      resolveInstance(registry, "investigate", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.investigate(input)),
      ),
  });

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  return makeTextGenerationFromRegistry(registry);
});

export const layer = Layer.effect(TextGeneration, make);
