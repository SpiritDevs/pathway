/**
 * Pure compilation and evaluation for company Slack intake routing rules.
 *
 * The compiler does the bounded structural work once per configuration revision. The poller can
 * then reuse the returned value for every message without repeatedly normalising prefixes or
 * walking an unbounded configuration.
 *
 * @module cloud/companySlackRules
 */
import {
  SLACK_ROUTING_MAX_NODES_PER_RULE,
  SLACK_ROUTING_MAX_NODES_PER_WATCH,
  SLACK_ROUTING_MAX_PREFIX_CHARS,
  SLACK_ROUTING_MAX_PREFIXES_PER_LEAF,
  SLACK_ROUTING_MAX_RULES_PER_CHANNEL,
  SLACK_ROUTING_MAX_SERIALIZED_BYTES,
  type CompanySlackRoutingCondition,
  type CompanySlackRoutingRule,
} from "@spiritdevs/contracts";

export const COMPANY_SLACK_REACTION_GRACE_MS = 60_000;

interface CompiledPrefix {
  /** The configured prefix, except for leading whitespace which intake ignores. */
  readonly source: string;
  /** A deterministic case-folded form used for matching. */
  readonly folded: string;
}

type CompiledCondition =
  | {
      readonly kind: "all" | "any";
      readonly conditions: ReadonlyArray<CompiledCondition>;
    }
  | {
      readonly kind: "text-prefix";
      /** Longest first, so a leaf finds its winning prefix without another scan. */
      readonly prefixes: ReadonlyArray<CompiledPrefix>;
    }
  | {
      readonly kind: "reaction";
      readonly emoji: string;
    }
  | {
      readonly kind: "bot-mention" | "every-message";
    };

interface CompiledRule {
  readonly source: CompanySlackRoutingRule;
  readonly condition: CompiledCondition;
}

/** Opaque, immutable input to the evaluator. Safe to cache by configuration revision. */
export interface CompiledCompanySlackRules {
  readonly rules: ReadonlyArray<CompiledRule>;
  readonly nodeCount: number;
  readonly serializedBytes: number;
  /** Lets the coordinator skip its bounded late-reaction scan for rulesets that cannot use it. */
  readonly hasReactionConditions: boolean;
}

export type CompanySlackRuleCompilationIssueCode =
  | "too-many-rules"
  | "too-many-nodes-in-rule"
  | "too-many-nodes-in-watch"
  | "empty-condition-group"
  | "too-many-prefixes"
  | "empty-prefix"
  | "prefix-too-long"
  | "serialized-rules-too-large"
  | "rules-not-serializable";

export interface CompanySlackRuleCompilationIssue {
  readonly code: CompanySlackRuleCompilationIssueCode;
  readonly message: string;
  readonly ruleIndex: number | null;
}

export type CompanySlackRuleCompilationResult =
  | {
      readonly ok: true;
      readonly value: CompiledCompanySlackRules;
    }
  | {
      readonly ok: false;
      readonly issues: ReadonlyArray<CompanySlackRuleCompilationIssue>;
    };

function issue(
  code: CompanySlackRuleCompilationIssueCode,
  message: string,
  ruleIndex: number | null = null,
): CompanySlackRuleCompilationIssue {
  return { code, message, ruleIndex };
}

function serializedByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return null;
  }
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

function validateCondition(
  root: CompanySlackRoutingCondition,
  ruleIndex: number,
): {
  readonly nodeCount: number;
  readonly issues: ReadonlyArray<CompanySlackRuleCompilationIssue>;
} {
  const issues: Array<CompanySlackRuleCompilationIssue> = [];
  const pending: Array<CompanySlackRoutingCondition> = [root];
  let nodeCount = 0;

  while (pending.length > 0) {
    const condition = pending.pop();
    if (condition === undefined) break;
    nodeCount += 1;

    // Stop walking this rule as soon as its hard node bound is exceeded. This keeps compilation
    // bounded even if it is accidentally called before contract decoding.
    if (nodeCount > SLACK_ROUTING_MAX_NODES_PER_RULE) break;

    if (condition.kind === "all" || condition.kind === "any") {
      if (condition.conditions.length === 0) {
        issues.push(
          issue(
            "empty-condition-group",
            `Slack routing rule ${ruleIndex + 1} has an empty ${condition.kind} condition.`,
            ruleIndex,
          ),
        );
      }
      for (const child of condition.conditions) pending.push(child);
      continue;
    }

    if (condition.kind !== "text-prefix") continue;

    if (condition.prefixes.length > SLACK_ROUTING_MAX_PREFIXES_PER_LEAF) {
      issues.push(
        issue(
          "too-many-prefixes",
          `Slack routing rule ${ruleIndex + 1} has more than ${SLACK_ROUTING_MAX_PREFIXES_PER_LEAF} prefixes in one condition.`,
          ruleIndex,
        ),
      );
    }

    for (const prefix of condition.prefixes) {
      const withoutLeadingWhitespace = prefix.trimStart();
      if (withoutLeadingWhitespace.length === 0) {
        issues.push(
          issue(
            "empty-prefix",
            `Slack routing rule ${ruleIndex + 1} contains an empty text prefix.`,
            ruleIndex,
          ),
        );
      } else if (characterLength(prefix) > SLACK_ROUTING_MAX_PREFIX_CHARS) {
        issues.push(
          issue(
            "prefix-too-long",
            `Slack routing rule ${ruleIndex + 1} contains a prefix longer than ${SLACK_ROUTING_MAX_PREFIX_CHARS} characters.`,
            ruleIndex,
          ),
        );
      }
    }
  }

  if (nodeCount > SLACK_ROUTING_MAX_NODES_PER_RULE) {
    issues.push(
      issue(
        "too-many-nodes-in-rule",
        `Slack routing rule ${ruleIndex + 1} has more than ${SLACK_ROUTING_MAX_NODES_PER_RULE} condition nodes.`,
        ruleIndex,
      ),
    );
  }

  return { nodeCount, issues };
}

function compileCondition(condition: CompanySlackRoutingCondition): CompiledCondition {
  switch (condition.kind) {
    case "all":
    case "any":
      return {
        kind: condition.kind,
        conditions: condition.conditions.map(compileCondition),
      };
    case "text-prefix": {
      const prefixes = new Map<string, CompiledPrefix>();
      for (const configured of condition.prefixes) {
        const source = configured.trimStart();
        const folded = source.toLowerCase();
        if (!prefixes.has(folded)) prefixes.set(folded, { source, folded });
      }
      return {
        kind: "text-prefix",
        prefixes: Array.from(prefixes.values()).toSorted(
          (left, right) => right.source.length - left.source.length,
        ),
      };
    }
    case "reaction":
      return { kind: "reaction", emoji: condition.emoji };
    case "bot-mention":
    case "every-message":
      return { kind: condition.kind };
  }
}

function hasReactionCondition(condition: CompanySlackRoutingCondition): boolean {
  if (condition.kind === "reaction") return true;
  if (condition.kind !== "all" && condition.kind !== "any") return false;
  return condition.conditions.some(hasReactionCondition);
}

/** Validate and precompute a routing ruleset without retaining any message state. */
export function compileCompanySlackRules(
  rules: ReadonlyArray<CompanySlackRoutingRule>,
): CompanySlackRuleCompilationResult {
  const issues: Array<CompanySlackRuleCompilationIssue> = [];
  const bytes = serializedByteLength({ configurationVersion: 2, rules });

  if (bytes === null) {
    return {
      ok: false,
      issues: [issue("rules-not-serializable", "Slack routing rules must be JSON serializable.")],
    };
  }
  if (bytes > SLACK_ROUTING_MAX_SERIALIZED_BYTES) {
    issues.push(
      issue(
        "serialized-rules-too-large",
        `Slack routing rules exceed the ${SLACK_ROUTING_MAX_SERIALIZED_BYTES}-byte limit.`,
      ),
    );
  }
  if (rules.length > SLACK_ROUTING_MAX_RULES_PER_CHANNEL) {
    issues.push(
      issue(
        "too-many-rules",
        `A Slack channel cannot have more than ${SLACK_ROUTING_MAX_RULES_PER_CHANNEL} routing rules.`,
      ),
    );
  }

  let totalNodeCount = 0;
  for (const [ruleIndex, rule] of rules.entries()) {
    const validation = validateCondition(rule.condition, ruleIndex);
    totalNodeCount += validation.nodeCount;
    issues.push(...validation.issues);
  }
  if (totalNodeCount > SLACK_ROUTING_MAX_NODES_PER_WATCH) {
    issues.push(
      issue(
        "too-many-nodes-in-watch",
        `Slack routing rules contain more than ${SLACK_ROUTING_MAX_NODES_PER_WATCH} condition nodes in total.`,
      ),
    );
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      rules: rules.map((rule) => ({ source: rule, condition: compileCondition(rule.condition) })),
      nodeCount: totalNodeCount,
      serializedBytes: bytes,
      hasReactionConditions: rules.some((rule) => hasReactionCondition(rule.condition)),
    },
  };
}

interface ConditionEvaluation {
  /** Whether the condition is true with the reactions currently on the message. */
  readonly matches: boolean;
  /** Whether the same condition would remain true if the message had no reactions. */
  readonly matchesWithoutReactions: boolean;
  /** Whether adding reactions, without changing any fixed fact, could make it true. */
  readonly canMatchWithAddedReactions: boolean;
  /** Prefixes participating in currently successful branches of this condition. */
  readonly matchedPrefixes: ReadonlyArray<CompiledPrefix>;
}

interface EvaluationFacts {
  readonly foldedText: string;
  readonly reactions: ReadonlySet<string>;
  readonly botMentioned: boolean;
}

function evaluateCondition(
  condition: CompiledCondition,
  facts: EvaluationFacts,
): ConditionEvaluation {
  switch (condition.kind) {
    case "every-message":
      return {
        matches: true,
        matchesWithoutReactions: true,
        canMatchWithAddedReactions: true,
        matchedPrefixes: [],
      };
    case "bot-mention":
      return {
        matches: facts.botMentioned,
        matchesWithoutReactions: facts.botMentioned,
        canMatchWithAddedReactions: facts.botMentioned,
        matchedPrefixes: [],
      };
    case "reaction": {
      const matches = facts.reactions.has(condition.emoji);
      return {
        matches,
        matchesWithoutReactions: false,
        canMatchWithAddedReactions: true,
        matchedPrefixes: [],
      };
    }
    case "text-prefix": {
      const matchedPrefix = condition.prefixes.find((prefix) =>
        facts.foldedText.startsWith(prefix.folded),
      );
      return {
        matches: matchedPrefix !== undefined,
        matchesWithoutReactions: matchedPrefix !== undefined,
        canMatchWithAddedReactions: matchedPrefix !== undefined,
        matchedPrefixes: matchedPrefix === undefined ? [] : [matchedPrefix],
      };
    }
    case "all": {
      const children = condition.conditions.map((child) => evaluateCondition(child, facts));
      const matches = children.every((child) => child.matches);
      return {
        matches,
        matchesWithoutReactions: children.every((child) => child.matchesWithoutReactions),
        canMatchWithAddedReactions: children.every((child) => child.canMatchWithAddedReactions),
        matchedPrefixes: matches ? children.flatMap((child) => child.matchedPrefixes) : [],
      };
    }
    case "any": {
      const children = condition.conditions.map((child) => evaluateCondition(child, facts));
      const matching = children.filter((child) => child.matches);
      return {
        matches: matching.length > 0,
        matchesWithoutReactions: children.some((child) => child.matchesWithoutReactions),
        canMatchWithAddedReactions: children.some((child) => child.canMatchWithAddedReactions),
        matchedPrefixes: matching.flatMap((child) => child.matchedPrefixes),
      };
    }
  }
}

export interface CompanySlackRuleEvaluationInput {
  readonly text: string;
  readonly reactions: ReadonlyArray<string> | ReadonlySet<string>;
  readonly botMentioned: boolean;
  /** Slack's seconds.microseconds timestamp. */
  readonly messageTs: string;
  /** Explicit clock input keeps grace evaluation deterministic and testable. */
  readonly nowMs: number;
}

export type CompanySlackRuleEvaluation =
  | {
      readonly kind: "match";
      readonly rule: CompanySlackRoutingRule;
      readonly ruleIndex: number;
      readonly matchedPrefix: string | null;
      /** True only when removing all current reactions would make this matched rule fail. */
      readonly matchedUsingReaction: boolean;
      /** Message text ready for `slackTitleFromText`; the original body stays unchanged. */
      readonly titleText: string;
    }
  | {
      readonly kind: "defer";
      readonly untilMs: number;
      readonly candidateRuleId: CompanySlackRoutingRule["id"];
      readonly blockingRuleIds: ReadonlyArray<CompanySlackRoutingRule["id"]>;
    }
  | {
      readonly kind: "ignore";
    };

function slackTimestampMilliseconds(timestamp: string): number | null {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1_000;
}

/** Evaluate ordered routing rules. One message can return at most one matched rule. */
export function evaluateCompanySlackRules(
  compiled: CompiledCompanySlackRules,
  input: CompanySlackRuleEvaluationInput,
): CompanySlackRuleEvaluation {
  const textWithoutLeadingWhitespace = input.text.trimStart();
  const facts: EvaluationFacts = {
    foldedText: textWithoutLeadingWhitespace.toLowerCase(),
    reactions: new Set(input.reactions),
    botMentioned: input.botMentioned,
  };
  const reactionDependentEarlierRules: Array<CompanySlackRoutingRule["id"]> = [];

  for (const [ruleIndex, compiledRule] of compiled.rules.entries()) {
    const evaluation = evaluateCondition(compiledRule.condition, facts);
    if (!evaluation.matches) {
      if (evaluation.canMatchWithAddedReactions) {
        reactionDependentEarlierRules.push(compiledRule.source.id);
      }
      continue;
    }

    const messageTimeMs = slackTimestampMilliseconds(input.messageTs);
    const untilMs =
      messageTimeMs === null ? input.nowMs : messageTimeMs + COMPANY_SLACK_REACTION_GRACE_MS;
    if (reactionDependentEarlierRules.length > 0 && input.nowMs < untilMs) {
      return {
        kind: "defer",
        untilMs,
        candidateRuleId: compiledRule.source.id,
        blockingRuleIds: reactionDependentEarlierRules,
      };
    }

    const matchedPrefix = evaluation.matchedPrefixes.toSorted(
      (left, right) => right.source.length - left.source.length,
    )[0];
    return {
      kind: "match",
      rule: compiledRule.source,
      ruleIndex,
      matchedPrefix: matchedPrefix?.source ?? null,
      matchedUsingReaction: !evaluation.matchesWithoutReactions,
      titleText:
        matchedPrefix === undefined
          ? input.text
          : textWithoutLeadingWhitespace.slice(matchedPrefix.source.length).trimStart(),
    };
  }

  return { kind: "ignore" };
}
