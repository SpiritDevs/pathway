import { readFileSync } from "node:fs";

import type { EmailAddress, EmailParsedHeaders } from "@t3tools/contracts";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { describe, expect, it } from "vite-plus/test";

import { analyzeEmailDeliverability } from "./DeliverabilityAnalyzer.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./testFixtures/${name}`, import.meta.url), "utf8");

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

const analyzeFixture = async (name: string) => {
  const source = fixture(name);
  const mail = await simpleParser(source);
  return analyzeEmailDeliverability({
    parsedHeaders: parsedHeaders(mail),
    // mailparser synthesizes text from HTML, while this check needs actual MIME-part presence.
    textBody: /^Content-Type:\s*text\/plain\b/im.test(source) ? mail.text || null : null,
    htmlBody: typeof mail.html === "string" ? mail.html : null,
  });
};

const statuses = (result: Awaited<ReturnType<typeof analyzeFixture>>) =>
  Object.fromEntries(result.checks.map((check) => [check.id, check.status]));

describe("analyzeEmailDeliverability", () => {
  it("passes a structurally complete multipart fixture without reaching the network", async () => {
    const result = await analyzeFixture("deliverability-pass.eml");

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
  });

  it("reports exact structural failures and content warnings from an HTML-only fixture", async () => {
    const result = await analyzeFixture("deliverability-warnings.eml");

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
  });
});
