import * as NodeServices from "@effect/platform-node/NodeServices";
import type { EmailAddress, EmailParsedHeaders } from "@spiritdevs/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";

import { analyzeEmailDeliverability } from "./DeliverabilityAnalyzer.ts";

const addresses = (
  value: AddressObject | AddressObject[] | undefined,
): ReadonlyArray<EmailAddress> => {
  const objects = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return objects.flatMap((object) =>
    object.value.map((address) => ({
      address: address.address ?? "unknown@example.test",
      name: address.name || null,
    })),
  );
};

const parsedHeaders = (mail: ParsedMail): EmailParsedHeaders => ({
  subject: mail.subject ?? null,
  messageId: mail.messageId ?? null,
  date: mail.date?.toISOString() ?? null,
  from: addresses(mail.from),
  to: addresses(mail.to),
  cc: addresses(mail.cc),
  bcc: addresses(mail.bcc),
  replyTo: addresses(mail.replyTo),
  headers: mail.headerLines.map(({ key, line }) => ({
    name: key,
    value: line.replace(/^[^:]+:\s*/, "").replace(/\r?\n[\t ]+/g, " "),
  })),
});

const analyzeFixture = Effect.fn("analyzeFixture")(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = yield* fs.readFileString(path.join(import.meta.dirname, "testFixtures", name));
  const mail = yield* Effect.promise(() => simpleParser(source));
  return analyzeEmailDeliverability({
    parsedHeaders: parsedHeaders(mail),
    // mailparser synthesizes text from HTML, while this check needs actual MIME-part presence.
    textBody: /^Content-Type:\s*text\/plain\b/im.test(source) ? mail.text || null : null,
    htmlBody: typeof mail.html === "string" ? mail.html : null,
  });
});

const statuses = (result: Effect.Success<ReturnType<typeof analyzeFixture>>) =>
  Object.fromEntries(result.checks.map((check) => [check.id, check.status]));

describe("analyzeEmailDeliverability", () => {
  it.effect("passes a structurally complete multipart fixture without reaching the network", () =>
    Effect.gen(function* () {
      const result = yield* analyzeFixture("deliverability-pass.eml");

      expect(statuses(result)).toEqual({
        spf: "pass",
        dkim: "pass",
        dmarc: "pass",
        "list-unsubscribe": "pass",
        "text-plain-alternative": "pass",
        "subject-length": "pass",
        "image-to-text-ratio": "pass",
        "tracking-pixels": "pass",
        "html-compatibility": "pass",
      });
      expect(result.metrics).toMatchObject({ imageCount: 1, trackingPixelCount: 0 });
      expect(result.htmlCompatibilityWarnings).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reports exact structural failures and content warnings from an HTML-only fixture",
    () =>
      Effect.gen(function* () {
        const result = yield* analyzeFixture("deliverability-warnings.eml");

        expect(statuses(result)).toEqual({
          spf: "fail",
          dkim: "fail",
          dmarc: "fail",
          "list-unsubscribe": "warning",
          "text-plain-alternative": "warning",
          "subject-length": "warning",
          "image-to-text-ratio": "warning",
          "tracking-pixels": "warning",
          "html-compatibility": "warning",
        });
        expect(result.metrics).toMatchObject({
          imageCount: 1,
          visibleTextCharacters: 8,
          trackingPixelCount: 1,
        });
        expect(result.htmlCompatibilityWarnings.map((warning) => warning.ruleId)).toEqual([
          "css-display-grid",
          "html-form",
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
