import { assert, describe, it } from "@effect/vitest";

import {
  buildCommentAgentPrompt,
  COMMENT_AGENT_REPLY_HEADING,
  nextCommentAgentPhase,
  parseCommentAgentAnswer,
  type CommentAgentPromptInput,
} from "./commentAgent.ts";

const PROMPT_INPUT: CommentAgentPromptInput = {
  key: "PAT-12",
  title: "Reconnect drops the queued turn",
  description: "After a relay reconnect the queued turn is lost.",
  statusName: "In Progress",
  priority: "high",
  labelNames: ["Bug"],
  projectName: "Pathway",
  thread: [
    { author: "The human", body: "Only on wifi.", isAsk: false },
    { author: "The human", body: "@Claude which layer drops it?", isAsk: true },
  ],
};

describe("buildCommentAgentPrompt", () => {
  it("carries the issue, the thread, and which comment is the ask", () => {
    const prompt = buildCommentAgentPrompt(PROMPT_INPUT);

    assert.include(prompt, "PAT-12: Reconnect drops the queued turn");
    assert.include(prompt, "Status: In Progress");
    assert.include(prompt, "Project: Pathway");
    assert.include(prompt, "Labels: Bug");
    assert.include(prompt, "Only on wifi.");
    assert.include(prompt, "@Claude which layer drops it?");
    // The last comment is the question; everything before it is history the agent may use.
    assert.isTrue(prompt.indexOf("this is what you were asked") > prompt.indexOf("Only on wifi."));
    // A comment thread is answered by writing, not by editing: the read-only rule leads.
    assert.isTrue(prompt.indexOf("do not change any files") < prompt.indexOf("PAT-12"));
    assert.include(prompt, COMMENT_AGENT_REPLY_HEADING);
    assert.include(prompt, "none, urgent, high, medium, low");
  });

  it("names the empty parts rather than leaving holes in the prompt", () => {
    const prompt = buildCommentAgentPrompt({
      ...PROMPT_INPUT,
      description: "   ",
      labelNames: [],
      projectName: null,
      thread: [],
    });

    assert.include(prompt, "Project: (none)");
    assert.include(prompt, "Labels: (none)");
    assert.include(prompt, "(empty)");
    assert.include(prompt, "(no comments)");
  });
});

describe("nextCommentAgentPhase", () => {
  it("moves forward on the first signal and never moves back", () => {
    assert.strictEqual(nextCommentAgentPhase("thinking", "Let me look at this."), "thinking");
    assert.strictEqual(nextCommentAgentPhase("thinking", "grep -n 'decode' src"), "researching");
    assert.strictEqual(
      nextCommentAgentPhase("thinking", "reading file apps/server/x.ts"),
      "researching",
    );
    // Still researching whatever the next chunk looks like: the phase only ever advances.
    assert.strictEqual(nextCommentAgentPhase("researching", "hmm"), "researching");
    assert.strictEqual(
      nextCommentAgentPhase("researching", "## Reply\n\nIt is the decoder."),
      "replying",
    );
    assert.strictEqual(nextCommentAgentPhase("replying", "rg 'decode'"), "replying");
    assert.strictEqual(nextCommentAgentPhase("replying", "anything at all"), "replying");
  });

  it("reads a reply heading, a final answer, and a self-announced reply", () => {
    assert.strictEqual(nextCommentAgentPhase("thinking", "#### reply"), "replying");
    assert.strictEqual(nextCommentAgentPhase("thinking", "So my final answer is:"), "replying");
    assert.strictEqual(nextCommentAgentPhase("thinking", "Here's my reply:"), "replying");
    // A model that says "reply" mid-sentence has not started one.
    assert.strictEqual(nextCommentAgentPhase("thinking", "I will reply once I know."), "thinking");
  });
});

describe("parseCommentAgentAnswer", () => {
  it("splits a fenced JSON tail off the reply and drops the scaffolding heading", () => {
    const answer = parseCommentAgentAnswer(
      [
        "## Reply",
        "",
        "The decoder drops the queued turn.",
        "",
        "```json",
        '{ "title": "Reconnect drops the queued turn", "priority": "HIGH" }',
        "```",
        "",
      ].join("\n"),
    );

    assert.strictEqual(answer.reply, "The decoder drops the queued turn.");
    assert.deepStrictEqual(answer.update, {
      title: "Reconnect drops the queued turn",
      priority: "high",
    });
  });

  it("reads a bare tail, a nested one, and normalizes what it finds", () => {
    const bare = parseCommentAgentAnswer(
      ["It is the decoder.", "", '{ "title": "A   wrapped   title", "priority": "nonsense" }'].join(
        "\n",
      ),
    );
    assert.strictEqual(bare.reply, "It is the decoder.");
    // One line, no runs of whitespace: a title is a row in a list. A priority it cannot read is
    // dropped rather than guessed at.
    assert.deepStrictEqual(bare.update, { title: "A wrapped title" });

    const nested = parseCommentAgentAnswer(
      [
        "It is the decoder.",
        "",
        "```json",
        '{ "update": { "description": "The relay drops it." } }',
        "```",
      ].join("\n"),
    );
    assert.deepStrictEqual(nested.update, { description: "The relay drops it." });
  });

  it("keeps an unusable tail as part of the reply rather than failing the run", () => {
    // Minutes of reading a repository, then a formatting slip: throwing the answer away here
    // would be the worst possible trade, so anything unparseable is simply prose.
    const broken = parseCommentAgentAnswer(
      ["It is the decoder.", "", "```json", "{ not json at all", "```"].join("\n"),
    );
    assert.isUndefined(broken.update);
    assert.include(broken.reply, "not json at all");

    const empty = parseCommentAgentAnswer(
      ["It is the decoder.", "", "```json", '{ "unrelated": true }', "```"].join("\n"),
    );
    assert.isUndefined(empty.update);
    assert.include(empty.reply, "unrelated");

    // A message that was *only* a JSON block still has to say something.
    const onlyJson = parseCommentAgentAnswer('```json\n{ "priority": "low" }\n```');
    assert.isUndefined(onlyJson.update);
    assert.include(onlyJson.reply, "priority");
  });

  it("answers with something even when the model said nothing", () => {
    assert.strictEqual(parseCommentAgentAnswer("   \n\n  ").reply, "(the agent returned nothing)");
    assert.strictEqual(
      parseCommentAgentAnswer("## Reply\n\n").reply,
      "(the agent returned nothing)",
    );
    // Carriage returns are the shell's, not the model's.
    assert.strictEqual(parseCommentAgentAnswer("## Reply\r\n\r\nDone.\r\n").reply, "Done.");
  });
});
