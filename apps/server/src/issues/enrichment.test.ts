import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ISSUE_DESCRIPTION_MAX_CHARS,
  ISSUE_ENRICHMENT_SUMMARY_MAX_CHARS,
  IssueEnrichmentResult,
} from "@t3tools/contracts";

import {
  appendInvestigationBlock,
  buildInvestigationBlock,
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

describe("buildInvestigationBlock", () => {
  const block = buildInvestigationBlock({
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
    assert.isTrue(block.startsWith("## Investigation (codex / gpt-5.4-codex, 2026-08-12)"));
  });

  it("renders the files, the keys, and the suggestions", () => {
    assert.include(block, "- `apps/server/src/ws.ts` — Owns reconnect");
    // A file with no reason is still a pointer; the em dash goes rather than the line.
    assert.include(block, "- `apps/web/src/state/threads.ts`\n");
    assert.include(block, "PAT-9, PAT-31");
    assert.include(block, "- Labels: Bug");
    assert.include(block, "- Priority: high");
  });

  it("says out loud that nothing was applied", () => {
    assert.include(block, "**Suggested** (not applied)");
  });

  it("omits the suggestion section when there is nothing to suggest", () => {
    const bare = buildInvestigationBlock({
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

describe("appendInvestigationBlock", () => {
  it("separates the block from what a human wrote", () => {
    assert.strictEqual(
      appendInvestigationBlock("The body.\n\n", "## Investigation (x, y)"),
      "The body.\n\n---\n\n## Investigation (x, y)",
    );
  });

  it("leaves no leading rule on an empty description", () => {
    assert.strictEqual(
      appendInvestigationBlock("", "## Investigation (x, y)"),
      "## Investigation (x, y)",
    );
  });

  it("appends a second run rather than replacing the first", () => {
    const once = appendInvestigationBlock("Body.", "## Investigation (x, 2026-08-11)");
    const twice = appendInvestigationBlock(once, "## Investigation (x, 2026-08-12)");

    // Two readings of a tree that moved between them; the older one is what was true then.
    assert.strictEqual(twice.match(/## Investigation/g)?.length, 2);
    assert.isTrue(twice.indexOf("2026-08-11") < twice.indexOf("2026-08-12"));
  });

  it("never returns more than a description is allowed to hold", () => {
    const body = "Human body.";
    const block = `## Investigation (x, y)\n${"detail ".repeat(400)}`;
    const appended = appendInvestigationBlock(body, block, 600);

    assert.isAtMost(appended.length, 600);
    assert.isTrue(appended.startsWith("Human body.\n\n---\n\n## Investigation"));
    assert.isTrue(appended.endsWith("[truncated]"));
  });

  it("leaves the description alone when there is no room for a readable block", () => {
    // A description already at the bound is what nine investigations before this one leave. The
    // tenth must not push it over: the editor round-trips the whole body, and one character past
    // the limit makes the field unsavable from every client.
    const full = "x".repeat(ISSUE_DESCRIPTION_MAX_CHARS - 100);
    const appended = appendInvestigationBlock(full, "## Investigation (x, y)\nSomething found.");

    assert.strictEqual(appended, full);
  });

  it("stays inside the bound however many investigations land on one issue", () => {
    // Each block is a full-sized summary plus the maximum likely-file list, which is the largest
    // one run can produce. Twenty of them is well past 100k of raw text.
    const block = buildInvestigationBlock({
      result: {
        summary: "s".repeat(ISSUE_ENRICHMENT_SUMMARY_MAX_CHARS),
        likelyFiles: Array.from({ length: 25 }, (_unused, index) => ({
          path: `apps/server/src/file-${index}.ts`,
          reason: "r".repeat(500),
        })),
        relatedIssueKeys: [],
        suggestedLabels: [],
        suggestedPriority: "high",
      },
      model: "codex / gpt-5.6-luna",
      finishedAt: "2026-08-12T14:31:02.000Z",
    });

    let description = "Human body.";
    for (let run = 0; run < 20; run += 1) {
      description = appendInvestigationBlock(description, block);
      assert.isAtMost(description.length, ISSUE_DESCRIPTION_MAX_CHARS);
    }
    // And the human's own text is still at the top of it, untouched.
    assert.isTrue(description.startsWith("Human body.\n\n---\n\n"));
  });
});
