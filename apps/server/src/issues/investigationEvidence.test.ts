import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ISSUE_DIAGNOSTIC_ATTACHMENT_MAX_BYTES } from "@spiritdevs/contracts";
import { prepareIssueEvidence } from "./investigationEvidence.ts";

const attachment = (fileName: string, mimeType: string, byteSize: number) => ({
  attachmentId: fileName,
  fileName,
  mimeType,
  byteSize,
  url: `https://example.test/${fileName}`,
});

describe("report evidence", () => {
  it.effect(
    "includes complete diagnostics beyond the normal comment limit and states omitted images",
    () =>
      Effect.gen(function* () {
        const text = "connection failure\n".repeat(3000) + "final failure evidence";
        const evidence = yield* prepareIssueEvidence(
          [
            attachment(
              "pathway-diagnostics.json",
              "application/json",
              new TextEncoder().encode(text).length,
            ),
            attachment("screenshot.jpg", "image/jpeg", 4),
          ],
          false,
          () => Effect.succeed(new TextEncoder().encode(text)),
        );
        expect(evidence.prompt).toContain("final failure evidence");
        expect(evidence.prompt).toContain("untrusted data");
        expect(evidence.omittedImages).toBe(1);
        expect(evidence.imagePaths).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("refuses an oversized combined diagnostic context before reading it", () =>
    Effect.gen(function* () {
      let reads = 0;
      const result = yield* prepareIssueEvidence(
        [
          attachment(
            "too-large.json",
            "application/json",
            ISSUE_DIAGNOSTIC_ATTACHMENT_MAX_BYTES * 2 + 1,
          ),
        ],
        false,
        () => {
          reads++;
          return Effect.succeed(new Uint8Array());
        },
      ).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(reads).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
