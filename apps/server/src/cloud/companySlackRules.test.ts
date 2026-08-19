import { describe, expect, it } from "@effect/vitest";
import {
  SLACK_ROUTING_MAX_NODES_PER_RULE,
  SLACK_ROUTING_MAX_PREFIX_CHARS,
  SLACK_ROUTING_MAX_PREFIXES_PER_LEAF,
  SLACK_ROUTING_MAX_RULES_PER_CHANNEL,
  type CompanySlackRoutingCondition,
  type CompanySlackRoutingRule,
} from "@spiritdevs/contracts";

import {
  COMPANY_SLACK_REACTION_GRACE_MS,
  compileCompanySlackRules,
  evaluateCompanySlackRules,
} from "./companySlackRules.ts";

function rule(id: string, condition: CompanySlackRoutingCondition): CompanySlackRoutingRule {
  return {
    id,
    name: id,
    condition,
    teamId: null,
    cloudProjectId: null,
    cycleId: null,
    initialStatusId: null,
    investigation: {
      timing: "off",
      triggerStatusId: null,
      successStatusId: null,
    },
    assignmentTiming: "off",
  } as CompanySlackRoutingRule;
}

function compile(rules: ReadonlyArray<CompanySlackRoutingRule>) {
  const result = compileCompanySlackRules(rules);
  if (!result.ok) throw new Error(result.issues.map((entry) => entry.message).join("\n"));
  return result.value;
}

function evaluate(
  rules: ReadonlyArray<CompanySlackRoutingRule>,
  input: Partial<Parameters<typeof evaluateCompanySlackRules>[1]> = {},
) {
  return evaluateCompanySlackRules(compile(rules), {
    text: "A Slack message",
    reactions: [],
    botMentioned: false,
    messageTs: "100.000000",
    nowMs: 100_000 + COMPANY_SLACK_REACTION_GRACE_MS,
    ...input,
  });
}

describe("company Slack routing rules", () => {
  it("evaluates arbitrary all/any nesting and keeps visible first-match order", () => {
    const first = rule("first", {
      kind: "all",
      conditions: [
        { kind: "bot-mention" },
        {
          kind: "any",
          conditions: [
            { kind: "reaction", emoji: "eyes" },
            {
              kind: "all",
              conditions: [
                { kind: "text-prefix", prefixes: ["support:"] },
                { kind: "every-message" },
              ],
            },
          ],
        },
      ],
    });
    const second = rule("second", { kind: "every-message" });

    expect(
      evaluate([first, second], {
        text: "support: Cannot sign in",
        botMentioned: true,
      }),
    ).toMatchObject({ kind: "match", rule: { id: "first" } });
    expect(
      evaluate([first, second], {
        text: "support: Cannot sign in",
        botMentioned: false,
      }),
    ).toMatchObject({ kind: "match", rule: { id: "second" } });

    expect(
      evaluate([rule("one", { kind: "every-message" }), rule("two", { kind: "every-message" })]),
    ).toMatchObject({ kind: "match", rule: { id: "one" }, ruleIndex: 0 });
  });

  it("matches prefixes after leading whitespace without case and strips the longest one from only the title input", () => {
    const result = evaluate(
      [
        rule("prefix", {
          kind: "any",
          conditions: [
            { kind: "text-prefix", prefixes: ["BUG:", "Bug: urgent:"] },
            { kind: "text-prefix", prefixes: ["bug:"] },
          ],
        }),
      ],
      { text: "  bUg: UrGeNt:   Checkout is broken" },
    );

    expect(result).toMatchObject({
      kind: "match",
      matchedPrefix: "Bug: urgent:",
      titleText: "Checkout is broken",
    });
  });

  it("uses reaction names and bot mention facts supplied by the coordinator", () => {
    expect(
      compile([
        rule("nested-reaction", {
          kind: "all",
          conditions: [{ kind: "any", conditions: [{ kind: "reaction", emoji: "eyes" }] }],
        }),
      ]).hasReactionConditions,
    ).toBe(true);
    expect(compile([rule("mention-only", { kind: "bot-mention" })]).hasReactionConditions).toBe(
      false,
    );

    const accumulatedFacts = {
      reactions: ["eyes", "rotating_light"],
      botMentioned: true,
    } as const;
    const reactionRules = [
      rule("reaction", { kind: "reaction", emoji: "rotating_light" }),
      rule("mention", { kind: "bot-mention" }),
    ];
    const firstEvaluation = evaluate(reactionRules, accumulatedFacts);
    expect(firstEvaluation).toMatchObject({
      kind: "match",
      rule: { id: "reaction" },
      matchedUsingReaction: true,
    });
    // The evaluator consumes the current accumulated fact set, not the Slack event that most
    // recently changed it, so retrying before Convex records the terminal decision is idempotent.
    expect(evaluate(reactionRules, accumulatedFacts)).toEqual(firstEvaluation);

    expect(
      evaluate(
        [
          rule("reaction", { kind: "reaction", emoji: "rotating_light" }),
          rule("mention", { kind: "bot-mention" }),
        ],
        { reactions: [], botMentioned: true },
      ),
    ).toMatchObject({
      kind: "match",
      rule: { id: "mention" },
      matchedUsingReaction: false,
    });

    expect(
      evaluate(
        [
          rule("reaction-or-prefix", {
            kind: "any",
            conditions: [
              { kind: "reaction", emoji: "eyes" },
              { kind: "text-prefix", prefixes: ["support:"] },
            ],
          }),
        ],
        { text: "support: Cannot sign in", reactions: ["eyes"] },
      ),
    ).toMatchObject({ kind: "match", matchedUsingReaction: false });
  });

  it("defers a lower match while an earlier rule can become true only through a reaction", () => {
    const rules = [
      rule("eyes-first", {
        kind: "all",
        conditions: [
          { kind: "text-prefix", prefixes: ["help:"] },
          { kind: "reaction", emoji: "eyes" },
        ],
      }),
      rule("catch-all", { kind: "every-message" }),
    ];

    expect(
      evaluate(rules, {
        text: "help: Printer is offline",
        nowMs: 159_999,
      }),
    ).toEqual({
      kind: "defer",
      untilMs: 160_000,
      candidateRuleId: "catch-all",
      blockingRuleIds: ["eyes-first"],
    });

    expect(
      evaluate(rules, {
        text: "help: Printer is offline",
        reactions: ["eyes"],
        nowMs: 120_000,
      }),
    ).toMatchObject({
      kind: "match",
      rule: { id: "eyes-first" },
      matchedUsingReaction: true,
    });

    expect(
      evaluate(rules, {
        text: "help: Printer is offline",
        nowMs: 160_000,
      }),
    ).toMatchObject({
      kind: "match",
      rule: { id: "catch-all" },
      matchedUsingReaction: false,
    });
  });

  it("does not defer when a fixed predicate makes an earlier reaction rule impossible", () => {
    expect(
      evaluate(
        [
          rule("other-prefix", {
            kind: "all",
            conditions: [
              { kind: "text-prefix", prefixes: ["sales:"] },
              { kind: "reaction", emoji: "eyes" },
            ],
          }),
          rule("catch-all", { kind: "every-message" }),
        ],
        { text: "support: Cannot sign in", nowMs: 101_000 },
      ),
    ).toMatchObject({ kind: "match", rule: { id: "catch-all" } });
  });

  it("returns ignore when no rule currently matches", () => {
    expect(evaluate([rule("mention", { kind: "bot-mention" })], { botMentioned: false })).toEqual({
      kind: "ignore",
    });
  });

  it("rejects configurations over each structural compiler bound", () => {
    const tooManyRules = compileCompanySlackRules(
      Array.from({ length: SLACK_ROUTING_MAX_RULES_PER_CHANNEL + 1 }, (_, index) =>
        rule(`rule-${index}`, { kind: "every-message" }),
      ),
    );
    expect(tooManyRules).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "too-many-rules" })]),
    });

    let tooDeep: CompanySlackRoutingCondition = { kind: "every-message" };
    for (let index = 0; index < SLACK_ROUTING_MAX_NODES_PER_RULE; index += 1) {
      tooDeep = { kind: "all", conditions: [tooDeep] };
    }
    expect(compileCompanySlackRules([rule("deep", tooDeep)])).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "too-many-nodes-in-rule" })]),
    });

    const maximumSizedTree = (): CompanySlackRoutingCondition => {
      let condition: CompanySlackRoutingCondition = { kind: "every-message" };
      for (let index = 1; index < SLACK_ROUTING_MAX_NODES_PER_RULE; index += 1) {
        condition = { kind: "all", conditions: [condition] };
      }
      return condition;
    };
    expect(
      compileCompanySlackRules(
        Array.from({ length: 6 }, (_, index) => rule(`aggregate-${index}`, maximumSizedTree())),
      ),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "too-many-nodes-in-watch" }),
      ]),
    });

    expect(
      compileCompanySlackRules([
        rule("prefix-count", {
          kind: "text-prefix",
          prefixes: Array.from(
            { length: SLACK_ROUTING_MAX_PREFIXES_PER_LEAF + 1 },
            (_, index) => `prefix-${index}`,
          ),
        }),
      ]),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "too-many-prefixes" })]),
    });

    expect(
      compileCompanySlackRules([
        rule("prefix-length", {
          kind: "text-prefix",
          prefixes: ["x".repeat(SLACK_ROUTING_MAX_PREFIX_CHARS + 1)],
        }),
      ]),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "prefix-too-long" })]),
    });

    expect(
      compileCompanySlackRules(
        [
          rule("serialized-size", {
            kind: "text-prefix",
            prefixes: ["valid:"],
          }),
          rule("large-name", { kind: "every-message" }),
        ].map((entry, index) =>
          index === 1 ? ({ ...entry, name: "x".repeat(33_000) } as CompanySlackRoutingRule) : entry,
        ),
      ),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "serialized-rules-too-large" }),
      ]),
    });

    expect(
      compileCompanySlackRules([rule("empty", { kind: "text-prefix", prefixes: ["   "] })]),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "empty-prefix" })]),
    });
  });
});
