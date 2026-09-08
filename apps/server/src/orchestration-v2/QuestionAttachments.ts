import type {
  ProviderUserInputAnswers,
  ThreadId,
  UserInputAttachments,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";

const quoteReference = Schema.encodeSync(Schema.fromJsonString(Schema.String));

export class QuestionAttachmentError extends Schema.TaggedErrorClass<QuestionAttachmentError>()(
  "QuestionAttachmentError",
  { message: Schema.String },
) {}

/** Resolve only saved files owned by this thread, before releasing the question. */
export const prepareQuestionAttachmentAnswers = Effect.fn("prepareQuestionAttachmentAnswers")(
  function* (input: {
    threadId: ThreadId;
    attachmentsDir: string;
    answers: ProviderUserInputAnswers;
    attachmentsByQuestionId: UserInputAttachments;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const answers = new Map(Object.entries(input.answers));
    for (const [questionId, attachments] of Object.entries(input.attachmentsByQuestionId)) {
      const lines: string[] = [];
      for (const attachment of attachments) {
        const path = resolveAttachmentPath({ attachmentsDir: input.attachmentsDir, attachment });
        if (
          !path ||
          parseThreadSegmentFromAttachmentId(attachment.id) !==
            toSafeThreadAttachmentSegment(input.threadId)
        ) {
          return yield* new QuestionAttachmentError({
            message: "The answer attachment does not belong to this conversation.",
          });
        }
        const info = yield* fs.stat(path).pipe(
          Effect.mapError(
            () =>
              new QuestionAttachmentError({
                message: `Attachment '${attachment.name}' is unavailable. Attach it again.`,
              }),
          ),
        );
        if (
          info.type !== "File" ||
          Number(info.size) !== attachment.sizeBytes ||
          attachment.sizeBytes === 0
        ) {
          return yield* new QuestionAttachmentError({
            message: `Attachment '${attachment.name}' is incomplete. Attach it again.`,
          });
        }
        lines.push(
          `Attached ${attachment.type} ${quoteReference(attachment.name)}: ${quoteReference(path)}. Open this file to see the user's answer.`,
        );
      }
      if (lines.length === 0) continue;
      const answer = answers.get(questionId);
      const references = lines.join("\n");
      answers.set(
        questionId,
        Array.isArray(answer)
          ? [...answer, references]
          : typeof answer === "string" && answer.length > 0
            ? `${answer}\n\n${references}`
            : references,
      );
    }
    return Object.fromEntries(answers);
  },
);
