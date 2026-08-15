import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { IssueEnrichmentResult, isPlaceholderIssueTitle } from "@spiritdevs/contracts";

import { SLACK_UNTITLED_ISSUE_TITLE } from "./IssueTrackerService.ts";
import {
  buildInvestigationComment,
  buildInvestigationPrompt,
  extractLastJsonObject,
  investigationErrorTail,
  normalizeInvestigationResult,
  type InvestigationPromptInput,
} from "./enrichment.ts";

const isEnrichmentResult = Schema.is(IssueEnrichmentResult);

const PROMPT_INPUT: InvestigationPromptInput = {
  key: "PAT-12",
  title: "Reconnect drops the queued turn",
  description: "After a relay reconnect the queued turn is lost.",
  statusName: "In Progress",
  priority: "high",
  labelNames: ["Bug"],
  todos: [
    { text: "Reproduce on a cold socket", done: true },
    { text: "Add a regression test", done: false },
  ],
  relations: [
    { kind: "blocks", direction: "incoming", key: "PAT-9", title: "Relay backoff" },
    { kind: "duplicate", direction: "outgoing", key: "PAT-4", title: "Lost turn" },
  ],
  comments: [
    { author: "The human", body: "Only on wifi." },
    { author: "Agent (codex)", body: "Suspect the reconnect path." },
  ],
  availableLabels: ["Bug", "Chore"],
  openIssues: [
    { key: "PAT-9", title: "Relay backoff" },
    { key: "PAT-31", title: "Socket teardown" },
  ],
};

describe("buildInvestigationPrompt", () => {
  it("states the read-only contract before anything else it says", () => {
    const prompt = buildInvestigationPrompt(PROMPT_INPUT);

    // The instruction has to come before the context: every provider here starts reading files
    // the moment it has a task, so a rule discovered afterwards is a rule discovered too late.
    assert.isTrue(prompt.indexOf("must not change") < prompt.indexOf("Issue PAT-12"));
    assert.include(prompt, "Do not edit, create, delete, or run anything that writes.");
  });

  it("carries the issue, its checklist, its relations, and its comments", () => {
    const prompt = buildInvestigationPrompt(PROMPT_INPUT);

    assert.include(prompt, "Issue PAT-12: Reconnect drops the queued turn");
    assert.include(prompt, "Status: In Progress");
    assert.include(prompt, "Priority: high");
    assert.include(prompt, "Labels: Bug");
    assert.include(prompt, "- [x] Reproduce on a cold socket");
    assert.include(prompt, "- [ ] Add a regression test");
    // An incoming `blocks` edge reads as "blocked by": the row is directed, the sentence is not.
    assert.include(prompt, "- blocked by PAT-9: Relay backoff");
    assert.include(prompt, "- duplicates PAT-4: Lost turn");
    assert.include(prompt, "- The human: Only on wifi.");
  });

  it("names the vocabulary it is allowed to answer from", () => {
    const prompt = buildInvestigationPrompt(PROMPT_INPUT);

    assert.include(prompt, "Existing labels:");
    assert.include(prompt, "- Chore");
    assert.include(prompt, "Open issues:");
    assert.include(prompt, "- PAT-31: Socket teardown");
    assert.include(prompt, "Do not invent an issue key or a label name");
  });

  it("asks for a title and a description only where the issue has none worth keeping", () => {
    const prompt = buildInvestigationPrompt(PROMPT_INPUT);

    assert.include(prompt, '"suggestedTitle": string — optional');
    assert.include(prompt, '"suggestedDescription": string — optional');
    // The gate is the whole point: an issue a person wrote a title for is not up for renaming.
    assert.include(
      prompt,
      'Include "suggestedTitle" only when the title above is one of the intake placeholders',
    );
    // The list the prompt names is the list `isPlaceholderIssueTitle` enforces. Prose that offers
    // a case the normalizer then drops is a request the model can only lose by answering.
    assert.include(prompt, '"Slack message", "Untitled", "New issue", or empty');
    for (const placeholder of ["Slack message", "Untitled", "New issue", "  "]) {
      assert.isTrue(isPlaceholderIssueTitle(placeholder));
    }
    assert.include(prompt, "no trailing punctuation");
    assert.include(
      prompt,
      'Include "suggestedDescription" only when the description above is empty or near-empty.',
    );
    assert.include(prompt, "Never");
    assert.include(prompt, "invent a detail");
    assert.include(prompt, "Priority and safe missing-field suggestions may be applied");
    assert.include(prompt, "labels remain for a person to review.");
    assert.include(prompt, "summary is appended to the issue description");
  });

  it("asks for a specific replacement title for a Slack-ingested issue", () => {
    const prompt = buildInvestigationPrompt({ ...PROMPT_INPUT, slackIngested: true });

    assert.include(prompt, "This issue was ingested from Slack");
    assert.include(prompt, 'Include "suggestedTitle" even though it already has');
    assert.include(prompt, "specific job to be done");
    assert.notInclude(prompt, "title above is one of the intake placeholders");
  });

  it("says so rather than going quiet when an issue has no body", () => {
    const prompt = buildInvestigationPrompt({ ...PROMPT_INPUT, description: "   " });

    assert.include(prompt, "Description:\n(empty)");
  });

  it("drops the sections an issue has nothing in", () => {
    const prompt = buildInvestigationPrompt({
      ...PROMPT_INPUT,
      todos: [],
      relations: [],
      comments: [],
    });

    assert.notInclude(prompt, "Checklist:");
    assert.notInclude(prompt, "Relations:");
    assert.notInclude(prompt, "Comments");
  });

  it("counts the images sent with the request, and the ones that were not", () => {
    const prompt = buildInvestigationPrompt({
      ...PROMPT_INPUT,
      images: { provided: 4, omitted: 2 },
    });

    // The model is handed pictures out of band and cannot count them; being told is what makes
    // "look at the screenshot" an instruction rather than a hope.
    assert.include(prompt, "Attachments:");
    assert.include(
      prompt,
      "- 4 image attachment(s) from this issue are provided with this request.",
    );
    // "not included" rather than "were not sent": the two that stayed behind may have been over
    // the cap, unreadable, or missing from the store, and the model can act on none of those.
    assert.include(prompt, "- 2 more attachment(s) on this issue were not included.");
  });

  it("says nothing about attachments when none were sent", () => {
    assert.notInclude(buildInvestigationPrompt(PROMPT_INPUT), "Attachments:");
    assert.notInclude(
      buildInvestigationPrompt({ ...PROMPT_INPUT, images: { provided: 0, omitted: 0 } }),
      "Attachments:",
    );
  });

  it("truncates a description rather than shipping a novel to the model", () => {
    const prompt = buildInvestigationPrompt({ ...PROMPT_INPUT, description: "x".repeat(20_000) });

    assert.include(prompt, "[truncated]");
    assert.isBelow(prompt.length, 20_000);
  });
});

describe("extractLastJsonObject", () => {
  it("reads a bare object", () => {
    assert.strictEqual(extractLastJsonObject('{"summary":"ok"}'), '{"summary":"ok"}');
  });

  it("strips a fence the model was told not to write", () => {
    const raw = ["Here you go:", "```json", '{"summary":"ok"}', "```"].join("\n");

    assert.strictEqual(extractLastJsonObject(raw), '{"summary":"ok"}');
  });

  it("takes the last object, not the first", () => {
    // The shape that forced this: an investigation quotes JSON on its way to the answer, and
    // scanning forwards would hand back the package.json fragment instead of the result.
    const raw = [
      'I read {"name":"pathway","version":"1.0.0"} first.',
      "",
      '{"summary":"the real answer","likelyFiles":[]}',
    ].join("\n");

    assert.strictEqual(
      extractLastJsonObject(raw),
      '{"summary":"the real answer","likelyFiles":[]}',
    );
  });

  it("keeps nested objects whole", () => {
    const raw = 'chatter {"summary":"s","likelyFiles":[{"path":"a.ts","reason":"r"}]} trailer';

    assert.strictEqual(
      extractLastJsonObject(raw),
      '{"summary":"s","likelyFiles":[{"path":"a.ts","reason":"r"}]}',
    );
  });

  it("is not fooled by braces inside strings", () => {
    const raw = '{"summary":"a } brace and a \\" quote"}';

    assert.strictEqual(extractLastJsonObject(raw), raw);
  });

  it("returns null when there is nothing balanced to find", () => {
    assert.isNull(extractLastJsonObject("I could not determine an answer."));
    assert.isNull(extractLastJsonObject('{"summary": "unterminated'));
    assert.isNull(extractLastJsonObject(""));
  });
});

describe("normalizeInvestigationResult", () => {
  const vocabulary = {
    knownIssueKeys: new Set(["PAT-9", "PAT-31"]),
    knownLabels: ["Bug", "Chore"],
  };

  it("accepts a well-formed result and produces something the contract admits", () => {
    const result = normalizeInvestigationResult(
      {
        summary: "The reconnect path drops the queued turn.",
        likelyFiles: [{ path: "apps/server/src/ws.ts", reason: "Owns reconnect" }],
        relatedIssueKeys: ["PAT-9"],
        suggestedLabels: ["Bug"],
        suggestedPriority: "high",
      },
      vocabulary,
    );

    assert.isNotNull(result);
    assert.isTrue(isEnrichmentResult(result));
    assert.deepStrictEqual(result?.relatedIssueKeys, ["PAT-9"]);
    assert.strictEqual(result?.suggestedPriority, "high");
  });

  it("refuses a result with no restated problem, and nothing else", () => {
    assert.isNull(normalizeInvestigationResult({ likelyFiles: [] }, vocabulary));
    assert.isNull(normalizeInvestigationResult({ summary: "   " }, vocabulary));
    assert.isNull(normalizeInvestigationResult("a sentence", vocabulary));
    assert.isNull(normalizeInvestigationResult([{ summary: "s" }], vocabulary));
    assert.isNull(normalizeInvestigationResult(null, vocabulary));

    // Everything except the summary is optional: a run that only restated the problem still
    // produced something worth appending.
    const bare = normalizeInvestigationResult({ summary: "Just this." }, vocabulary);
    assert.deepStrictEqual(bare, {
      summary: "Just this.",
      likelyFiles: [],
      relatedIssueKeys: [],
      suggestedLabels: [],
      suggestedPriority: null,
    });
  });

  it("drops keys and labels the model invented", () => {
    const result = normalizeInvestigationResult(
      {
        summary: "s",
        relatedIssueKeys: ["PAT-9", "PAT-999", "not a key", "pat-31"],
        suggestedLabels: ["bug", "Regression", "  chore  "],
      },
      vocabulary,
    );

    // `pat-31` is the same key shouted quietly; `PAT-999` is one nobody has.
    assert.deepStrictEqual(result?.relatedIssueKeys, ["PAT-9", "PAT-31"]);
    // Matched case-insensitively, stored as the tracker spells it, so "apply" resolves.
    assert.deepStrictEqual(result?.suggestedLabels, ["Bug", "Chore"]);
  });

  it("clamps rather than rejecting when the model over-answers", () => {
    const result = normalizeInvestigationResult(
      {
        summary: "s".repeat(20_000),
        likelyFiles: Array.from({ length: 40 }, (_, index) => ({
          path: `file-${index}.ts`,
          reason: "r",
        })),
        suggestedPriority: "extremely urgent",
      },
      vocabulary,
    );

    assert.isTrue(isEnrichmentResult(result));
    assert.strictEqual(result?.likelyFiles.length, 25);
    assert.strictEqual(result?.summary.length, 8_000);
    // A priority outside the five is no priority, not a failure.
    assert.isNull(result?.suggestedPriority ?? null);
  });

  it("takes a proposed title and description, one line and trimmed", () => {
    const result = normalizeInvestigationResult(
      {
        summary: "s",
        suggestedTitle: "  Reconnect\n  drops the queued turn  ",
        suggestedDescription: "  A relay reconnect loses the queued turn.\n\nSeen on wifi.  ",
      },
      vocabulary,
    );

    assert.isTrue(isEnrichmentResult(result));
    // A title is a row in a list, whatever the model wrapped.
    assert.strictEqual(result?.suggestedTitle, "Reconnect drops the queued turn");
    assert.strictEqual(
      result?.suggestedDescription,
      "A relay reconnect loses the queued turn.\n\nSeen on wifi.",
    );
  });

  it("leaves the keys out when the model had nothing to propose", () => {
    const result = normalizeInvestigationResult(
      { summary: "s", suggestedTitle: "   ", suggestedDescription: "\n\n", suggestedLabels: [] },
      vocabulary,
    );

    // Absent rather than empty: the result is stored as JSON, and a suggestion nobody made must
    // not read as one.
    assert.isFalse("suggestedTitle" in (result ?? {}));
    assert.isFalse("suggestedDescription" in (result ?? {}));

    const wrongTypes = normalizeInvestigationResult(
      { summary: "s", suggestedTitle: 12, suggestedDescription: { text: "x" } },
      vocabulary,
    );
    assert.isFalse("suggestedTitle" in (wrongTypes ?? {}));
    assert.isFalse("suggestedDescription" in (wrongTypes ?? {}));
  });

  it("clamps a title and a description the model ran long on", () => {
    const result = normalizeInvestigationResult(
      { summary: "s", suggestedTitle: "t".repeat(2_000), suggestedDescription: "d".repeat(20_000) },
      vocabulary,
    );

    assert.isTrue(isEnrichmentResult(result));
    assert.strictEqual(result?.suggestedTitle?.length, 512);
    assert.strictEqual(result?.suggestedDescription?.length, 8_000);
  });

  it("drops a suggestion that proposes what the issue already says", () => {
    const result = normalizeInvestigationResult(
      {
        summary: "s",
        suggestedTitle: "Reconnect  drops the queued turn",
        suggestedDescription: "Already written.",
      },
      {
        ...vocabulary,
        currentTitle: "Reconnect drops the queued turn",
        currentDescription: "  Already written.  ",
      },
    );

    assert.isFalse("suggestedTitle" in (result ?? {}));
    assert.isFalse("suggestedDescription" in (result ?? {}));
  });

  it("retains an unexpected title suggestion for the live provenance decision", () => {
    const result = normalizeInvestigationResult(
      { summary: "s", suggestedTitle: "Websocket reconnect loses the queued turn" },
      { ...vocabulary, currentTitle: "Reconnect drops the queued turn" },
    );

    // The model was asked to omit this, but the issue may have changed while it ran. The
    // completion path owns the live author check and leaves a user title for confirmation.
    assert.strictEqual(result?.suggestedTitle, "Websocket reconnect loses the queued turn");
    assert.strictEqual(result?.summary, "s");
  });

  it("takes a title for an issue that arrived without one of its own", () => {
    for (const currentTitle of [
      SLACK_UNTITLED_ISSUE_TITLE,
      "  slack message ",
      "Untitled",
      "New issue",
      "",
      "   ",
    ]) {
      const result = normalizeInvestigationResult(
        { summary: "s", suggestedTitle: "Reconnect drops the queued turn" },
        { ...vocabulary, currentTitle },
      );

      assert.strictEqual(
        result?.suggestedTitle,
        "Reconnect drops the queued turn",
        `expected a suggestion for the placeholder title ${JSON.stringify(currentTitle)}`,
      );
    }

    // The intake default and the predicate are one fact in two files. If Slack's untitled issues
    // ever get another name, this is what says the investigation may still name them.
    assert.isTrue(isPlaceholderIssueTitle(SLACK_UNTITLED_ISSUE_TITLE));

    // No opinion offered is no gate: the caller that omits `currentTitle` gets the suggestion.
    assert.strictEqual(
      normalizeInvestigationResult(
        { summary: "s", suggestedTitle: "Reconnect drops the queued turn" },
        vocabulary,
      )?.suggestedTitle,
      "Reconnect drops the queued turn",
    );
  });

  it("keeps a bare-string likely file, and skips the entries with no path at all", () => {
    const result = normalizeInvestigationResult(
      { summary: "s", likelyFiles: ["apps/web/src/App.tsx", { reason: "no path" }, { path: " " }] },
      vocabulary,
    );

    assert.deepStrictEqual(result?.likelyFiles, [{ path: "apps/web/src/App.tsx", reason: "" }]);
  });
});

describe("investigationErrorTail", () => {
  it("quotes the end, where the answer should have been", () => {
    const tail = investigationErrorTail(`${"reading files\n".repeat(500)}I give up.`);

    assert.isTrue(tail.startsWith("…"));
    assert.isTrue(tail.endsWith("I give up."));
    assert.isBelow(tail.length, 1_300);
  });

  it("quotes short output whole", () => {
    assert.strictEqual(investigationErrorTail("  nope  "), "nope");
  });
});

describe("buildInvestigationComment", () => {
  const comment = buildInvestigationComment({
    result: {
      summary: "The reconnect path drops the queued turn.",
      likelyFiles: [
        { path: "apps/server/src/ws.ts", reason: "Owns reconnect" },
        { path: "apps/web/src/state/threads.ts", reason: "" },
      ],
      relatedIssueKeys: ["PAT-9", "PAT-31"],
      suggestedLabels: ["Bug"],
      suggestedPriority: "high",
    },
    model: "codex / gpt-5.4-codex",
    finishedAt: "2026-08-12T14:31:02.000Z",
  });

  it("heads the block with what ran it and when", () => {
    assert.isTrue(comment.startsWith("## Investigation (codex / gpt-5.4-codex, 2026-08-12)"));
  });

  it("renders the files, the keys, and the suggestions", () => {
    assert.include(comment, "- `apps/server/src/ws.ts` — Owns reconnect");
    // A file with no reason is still a pointer; the em dash goes rather than the line.
    assert.include(comment, "- `apps/web/src/state/threads.ts`\n");
    assert.include(comment, "PAT-9, PAT-31");
    assert.include(comment, "- Labels: Bug");
    assert.include(comment, "- Priority: high");
  });

  it("does not falsely claim that every suggestion stayed unapplied", () => {
    assert.include(comment, "**Suggested**");
    assert.notInclude(comment, "(not applied)");
  });

  it("renders a proposed title on one line and a proposed description as a quote", () => {
    const named = buildInvestigationComment({
      result: {
        summary: "s",
        likelyFiles: [],
        relatedIssueKeys: [],
        suggestedLabels: [],
        suggestedPriority: null,
        suggestedTitle: "Reconnect drops the queued turn",
        suggestedDescription: "A relay reconnect loses the queued turn.\n\nSeen on wifi.",
      },
      model: "codex / gpt-5.4-codex",
      finishedAt: "2026-08-12T14:31:02.000Z",
    });

    assert.include(named, "- Title: Reconnect drops the queued turn\n");
    // Quoted, so a proposed body cannot merge into the comment around it.
    assert.include(named, "- Description:\n\n> A relay reconnect loses the queued turn.\n>\n");
    assert.include(named, "> Seen on wifi.");
  });

  it("leaves the title and description lines out when the run proposed neither", () => {
    assert.notInclude(comment, "- Title:");
    assert.notInclude(comment, "- Description:");
  });

  it("omits the suggestion section when there is nothing to suggest", () => {
    const bare = buildInvestigationComment({
      result: {
        summary: "s",
        likelyFiles: [],
        relatedIssueKeys: [],
        suggestedLabels: [],
        suggestedPriority: null,
      },
      model: "codex / gpt-5.4-codex",
      finishedAt: "2026-08-12T14:31:02.000Z",
    });

    assert.notInclude(bare, "Suggested");
    assert.notInclude(bare, "Likely files");
  });
});
