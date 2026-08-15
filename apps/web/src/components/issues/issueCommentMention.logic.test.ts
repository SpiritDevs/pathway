import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterIssueCommentMentionAgents,
  findIssueCommentAgentMentions,
  findIssueCommentMentionQuery,
  issueCommentMentionBody,
  issueCommentMentionModelSummary,
  issueCommentMentionPillMarkdown,
  normalizeIssueCommentMentionName,
  removeIssueCommentMentionQuery,
  resolveIssueCommentMention,
  type IssueCommentMentionAgent,
} from "./issueCommentMention.logic";

const CLAUDE: IssueCommentMentionAgent = {
  instanceId: ProviderInstanceId.make("claude-default"),
  provider: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
};

const CODEX: IssueCommentMentionAgent = {
  instanceId: ProviderInstanceId.make("codex-default"),
  provider: ProviderDriverKind.make("codex"),
  displayName: "Codex",
};

const AGENTS = [CLAUDE, CODEX];

describe("inline mention query", () => {
  it("opens at a token-leading @ and follows the caret", () => {
    expect(findIssueCommentMentionQuery("please @cl", 10)).toEqual({
      index: 7,
      length: 3,
      value: "cl",
    });
    expect(findIssueCommentMentionQuery("@", 1)).toEqual({ index: 0, length: 1, value: "" });
  });

  it("does not treat email addresses or closed punctuation as mention queries", () => {
    expect(findIssueCommentMentionQuery("me@example.com", 14)).toBeNull();
    expect(findIssueCommentMentionQuery("ask @Claude, please", 12)).toBeNull();
  });

  it("filters configured instances without case sensitivity", () => {
    expect(filterIssueCommentMentionAgents(AGENTS, "AU")).toEqual([CLAUDE]);
    expect(filterIssueCommentMentionAgents(AGENTS, "")).toEqual(AGENTS);
    expect(filterIssueCommentMentionAgents(AGENTS, "gemini")).toEqual([]);
  });

  it("consumes only the query and returns the next caret position", () => {
    expect(
      removeIssueCommentMentionQuery("please @cl review", {
        index: 7,
        length: 3,
        value: "cl",
      }),
    ).toEqual({ text: "please  review", caret: 7 });
  });
});

describe("normalizeIssueCommentMentionName", () => {
  it("drops case, surrounding space, and the decorative @", () => {
    expect(normalizeIssueCommentMentionName("  @Claude ")).toBe("claude");
    expect(normalizeIssueCommentMentionName("@@ CODEX")).toBe("codex");
  });
});

describe("findIssueCommentAgentMentions", () => {
  it("matches a name written on either side of the link, whatever the case", () => {
    expect(
      findIssueCommentAgentMentions("hey [claude](Claude) and [x](@CODEX)", AGENTS).map(
        (mention) => mention.agent.instanceId,
      ),
    ).toEqual([CLAUDE.instanceId, CODEX.instanceId]);
  });

  it("matches the persisted pill href so a pasted body is not mentioned twice", () => {
    const [mention] = findIssueCommentAgentMentions(
      "[@Claude](mention:agent:claudeAgent) please look",
      AGENTS,
    );

    expect(mention?.agent).toBe(CLAUDE);
    expect(mention?.index).toBe(0);
    expect(mention?.raw).toBe("[@Claude](mention:agent:claudeAgent)");
  });

  it("leaves links that name nothing configured alone", () => {
    expect(
      findIssueCommentAgentMentions("see [the docs](https://example.com/claudeAgent)", AGENTS),
    ).toEqual([]);
    expect(findIssueCommentAgentMentions("[Gemini](Gemini)", AGENTS)).toEqual([]);
  });

  it("finds nothing when no agent is configured", () => {
    expect(findIssueCommentAgentMentions("[Claude](Claude)", [])).toEqual([]);
  });

  it("reports offsets that index the text it scanned", () => {
    const text = "ok [Codex](Codex) go";
    const [mention] = findIssueCommentAgentMentions(text, AGENTS);

    expect(mention).toBeDefined();
    expect(text.slice(mention?.index ?? 0, (mention?.index ?? 0) + (mention?.length ?? 0))).toBe(
      "[Codex](Codex)",
    );
  });
});

describe("resolveIssueCommentMention", () => {
  const base = { agents: AGENTS, pickedInstanceId: null, dismissedRaw: null } as const;

  it("takes the first typed mention when several name agents", () => {
    const resolution = resolveIssueCommentMention({
      ...base,
      text: "[Codex](Codex) and [Claude](Claude)",
    });

    expect(resolution?.agent).toBe(CODEX);
    expect(resolution?.typed?.raw).toBe("[Codex](Codex)");
  });

  it("lets the picker outrank the text while still replacing the typed token", () => {
    const resolution = resolveIssueCommentMention({
      ...base,
      text: "hi [Claude](Claude)",
      pickedInstanceId: CODEX.instanceId,
    });

    expect(resolution?.agent).toBe(CODEX);
    expect(resolution?.typed?.raw).toBe("[Claude](Claude)");
  });

  it("resolves a picker choice with nothing typed", () => {
    const resolution = resolveIssueCommentMention({
      ...base,
      text: "please take a look",
      pickedInstanceId: CLAUDE.instanceId,
    });

    expect(resolution?.agent).toBe(CLAUDE);
    expect(resolution?.typed).toBeNull();
  });

  it("skips a dismissed token but still sees a later one", () => {
    expect(
      resolveIssueCommentMention({
        ...base,
        text: "[Claude](Claude)",
        dismissedRaw: "[Claude](Claude)",
      }),
    ).toBeNull();
    expect(
      resolveIssueCommentMention({
        ...base,
        text: "[Claude](Claude) then [Codex](Codex)",
        dismissedRaw: "[Claude](Claude)",
      })?.agent,
    ).toBe(CODEX);
  });

  it("resolves nothing from text without a mention", () => {
    expect(resolveIssueCommentMention({ ...base, text: "just a comment" })).toBeNull();
  });

  it("ignores a picked instance that is no longer configured", () => {
    expect(
      resolveIssueCommentMention({
        ...base,
        text: "just a comment",
        pickedInstanceId: ProviderInstanceId.make("removed"),
      }),
    ).toBeNull();
  });
});

describe("issueCommentMentionBody", () => {
  it("replaces the typed token in place", () => {
    const text = "hey [claude](Claude), can you check this?";
    const resolution = resolveIssueCommentMention({
      text,
      agents: AGENTS,
      pickedInstanceId: null,
      dismissedRaw: null,
    });

    expect(resolution).not.toBeNull();
    expect(issueCommentMentionBody(text, resolution!)).toBe(
      "hey [@Claude](mention:agent:claudeAgent), can you check this?",
    );
  });

  it("prefixes the body when the picker added the mention", () => {
    expect(issueCommentMentionBody("can you check this?", { agent: CODEX, typed: null })).toBe(
      "[@Codex](mention:agent:codex) can you check this?",
    );
  });

  it("round-trips: the rewritten body resolves back to the same agent", () => {
    const body = issueCommentMentionBody("look at this", { agent: CLAUDE, typed: null });
    const again = resolveIssueCommentMention({
      text: body,
      agents: AGENTS,
      pickedInstanceId: null,
      dismissedRaw: null,
    });

    expect(again?.agent).toBe(CLAUDE);
    expect(again?.typed?.raw).toBe(issueCommentMentionPillMarkdown(CLAUDE));
    // Rewriting an already-rewritten body is a no-op, so a resubmit cannot stack pills.
    expect(issueCommentMentionBody(body, again!)).toBe(body);
  });
});

describe("issueCommentMentionPillMarkdown", () => {
  it("strips brackets that would close the link early", () => {
    expect(issueCommentMentionPillMarkdown({ ...CLAUDE, displayName: "Claude [work] (2)" })).toBe(
      "[@Claude work 2](mention:agent:claudeAgent)",
    );
  });

  it("falls back to the driver kind when the name is only punctuation", () => {
    expect(issueCommentMentionPillMarkdown({ ...CLAUDE, displayName: "[]" })).toBe(
      "[@claudeAgent](mention:agent:claudeAgent)",
    );
  });
});

describe("issueCommentMentionModelSummary", () => {
  const option = (id: string, value: string | boolean): ProviderOptionSelection =>
    ({ id, value }) as ProviderOptionSelection;

  it("prints the model alone when nothing is pinned", () => {
    expect(issueCommentMentionModelSummary({ model: "sonnet" })).toBe("sonnet");
    expect(issueCommentMentionModelSummary({ model: "sonnet", options: [] })).toBe("sonnet");
  });

  it("names an enabled boolean option and prints a string option's value", () => {
    expect(
      issueCommentMentionModelSummary({
        model: "sonnet",
        options: [option("reasoning", "high"), option("web search", true), option("cache", false)],
      }),
    ).toBe("sonnet · high · web search");
  });
});
