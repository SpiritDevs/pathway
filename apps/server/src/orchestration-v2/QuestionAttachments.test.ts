import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ChatAttachmentId, ThreadId } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { prepareQuestionAttachmentAnswers } from "./QuestionAttachments.ts";

const threadId = ThreadId.make("answer-thread");
const attachment = {
  type: "image" as const,
  id: ChatAttachmentId.make("answer-thread-00000000-0000-4000-8000-000000000001"),
  name: 'Design "日本語".png',
  mimeType: "image/png",
  sizeBytes: 3,
};

it.effect("keeps question ownership and selected answers when adding quoted image paths", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const attachmentsDir = yield* fs.makeTempDirectoryScoped();
    const path = resolveAttachmentPath({ attachmentsDir, attachment });
    assert.isNotNull(path);
    yield* fs.writeFileString(path!, "png");
    const answers = yield* prepareQuestionAttachmentAnswers({
      threadId,
      attachmentsDir,
      answers: { first: ["Keep the header"], second: "Unchanged" },
      attachmentsByQuestionId: { first: [attachment] },
    });
    assert.deepEqual(answers.second, "Unchanged");
    assert.isArray(answers.first);
    if (!Array.isArray(answers.first)) return yield* Effect.die("Expected an array answer.");
    assert.equal(answers.first[0], "Keep the header");
    assert.include(answers.first[1], 'Design \\"日本語\\".png');
    assert.include(answers.first[1], path!);
    const imageOnly = yield* prepareQuestionAttachmentAnswers({
      threadId,
      attachmentsDir,
      answers: {},
      attachmentsByQuestionId: { first: [attachment] },
    });
    assert.include(String(imageOnly.first), "Open this file");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const problem of ["missing", "empty", "wrong-thread", "size-mismatch"] as const) {
  it.effect(`rejects ${problem} answer attachments before provider delivery`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const attachmentsDir = yield* fs.makeTempDirectoryScoped();
      if (problem !== "missing")
        yield* fs.writeFileString(
          resolveAttachmentPath({ attachmentsDir, attachment })!,
          problem === "empty" ? "" : "png",
        );
      const result = yield* prepareQuestionAttachmentAnswers({
        threadId: problem === "wrong-thread" ? ThreadId.make("another-thread") : threadId,
        attachmentsDir,
        answers: {},
        attachmentsByQuestionId: {
          first: [
            {
              ...attachment,
              sizeBytes: problem === "empty" ? 0 : problem === "size-mismatch" ? 2 : 3,
            },
          ],
        },
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
