import { Agent, type AgentOptions, type RunResult } from "@cursor/sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { type CursorSettings, type ModelSelection } from "@spiritdevs/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@spiritdevs/shared/git";
import { extractJsonObject } from "@spiritdevs/shared/schemaJson";

import { TextGenerationError } from "@spiritdevs/contracts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  INVESTIGATION_TIMEOUT_MS,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import { cursorSdkModelSelection } from "../provider/cursorSdkModel.ts";

const CURSOR_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);
type CursorTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "investigate";

function emptyCursorSdkResultDetail(result: RunResult): string {
  switch (result.status) {
    case "cancelled":
      return "Cursor SDK request was cancelled.";
    case "error":
      return "Cursor SDK request finished with an error and no output.";
    case "finished":
      return "Cursor SDK returned empty output.";
  }
}

/**
 * Build a Cursor text-generation closure bound to a specific `CursorSettings`
 * payload. See `makeCodexAdapter` for the overall per-instance rationale.
 */
export const makeCursorTextGeneration = Effect.fn("makeCursorTextGeneration")((
  cursorSettings: CursorSettings,
  environment?: NodeJS.ProcessEnv,
) => {
  const resolvedEnvironment = environment ?? process.env;

  const resolveCursorApiKey = (operation: CursorTextGenerationOperation) =>
    Effect.gen(function* () {
      if (!cursorSettings.enabled) {
        return yield* new TextGenerationError({
          operation,
          detail: "Cursor is disabled in Pathway settings.",
        });
      }

      const apiKey = resolvedEnvironment.CURSOR_API_KEY?.trim();
      if (!apiKey) {
        return yield* new TextGenerationError({
          operation,
          detail: "Cursor API key is required. Add CURSOR_API_KEY in provider settings.",
        });
      }

      return apiKey;
    });

  const runCursorJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation: CursorTextGenerationOperation;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const apiKey = yield* resolveCursorApiKey(operation);
      const agentOptions = {
        apiKey,
        mode: "agent",
        model: cursorSdkModelSelection(modelSelection),
        local: {
          cwd,
          autoReview: false,
          sandboxOptions: { enabled: false },
          enableAgentRetries: true,
        },
      } satisfies AgentOptions;

      const promptResult = yield* Effect.tryPromise({
        try: () => Agent.prompt(prompt, agentOptions),
        catch: (cause) =>
          new TextGenerationError({
            operation,
            detail: "Cursor SDK request failed.",
            cause,
          }),
      }).pipe(
        Effect.timeoutOption(CURSOR_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Cursor SDK request timed out.",
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
      );

      const rawResult = promptResult.result?.trim() ?? "";
      if (!rawResult) {
        return yield* new TextGenerationError({
          operation,
          detail: emptyCursorSdkResultDetail(promptResult),
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(rawResult)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Cursor SDK returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Cursor SDK text generation failed.",
              cause,
            }),
      ),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("CursorTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runCursorJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("CursorTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runCursorJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("CursorTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runCursorJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("CursorTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });

      const generated = yield* runCursorJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  const investigate: TextGeneration.TextGeneration["Service"]["investigate"] = Effect.fn(
    "CursorTextGeneration.investigate",
  )(function* (input) {
    const operation = "investigate" as const;
    const apiKey = yield* resolveCursorApiKey(operation);
    const promptResult = yield* Effect.tryPromise({
      try: () =>
        Agent.prompt(input.prompt, {
          apiKey,
          mode: "agent",
          model: cursorSdkModelSelection(input.modelSelection),
          local: {
            cwd: input.cwd,
            autoReview: false,
            sandboxOptions: { enabled: false },
            enableAgentRetries: true,
          },
        }),
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail: "Cursor SDK request failed.",
          cause,
        }),
    }).pipe(
      Effect.timeoutOption(INVESTIGATION_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Cursor SDK request timed out.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
    const text = promptResult.result?.trim() ?? "";
    if (!text) {
      return yield* new TextGenerationError({
        operation,
        detail: emptyCursorSdkResultDetail(promptResult),
      });
    }
    yield* input.onOutput?.(text) ?? Effect.void;
    return { text };
  });

  return Effect.succeed({
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    investigate,
  } satisfies TextGeneration.TextGeneration["Service"]);
});
