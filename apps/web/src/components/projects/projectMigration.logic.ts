/**
 * Pre-matching for a project move between companies.
 *
 * Statuses and labels are company-owned, so moving a project means deciding what each of the
 * source company's values becomes in the destination. Most of that decision is obvious — "In
 * Progress" is "In progress" — and asking a person to restate it for every row is how a migration
 * gets abandoned halfway. So the obvious ones are proposed automatically and the rest are left
 * blank, deliberately: a wrong guess that looks confident is worse than an empty field.
 *
 * @module components/projects/projectMigration.logic
 */

export interface NamedValue {
  readonly id: string;
  readonly name: string;
  /** Statuses carry one; labels do not. Used to break ties between equally-named candidates. */
  readonly category?: string;
}

/** How a proposed pairing was arrived at, so the wizard can show its confidence. */
export type MatchConfidence = "exact" | "close" | "none";

export interface ProposedMatch {
  readonly sourceId: string;
  readonly targetId: string | null;
  readonly confidence: MatchConfidence;
}

/** Lowercase, strip anything that is not a letter or digit. "In-Progress" and "in progress" agree. */
export function normalizeMatchName(name: string): string {
  return name.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

/**
 * Proposes a destination for every source value.
 *
 * Three passes, strongest first, and a target is claimed at most once: two source statuses that
 * both normalise to "done" must not silently collapse, because the second one would then look
 * mapped when nobody chose where it goes.
 *
 * 1. Exact name.
 * 2. Same name ignoring case, punctuation, and spacing.
 * 3. Same category, but only when exactly one candidate in that category is left — an unambiguous
 *    structural match. Anything less certain is left for the user.
 */
export function proposeMatches(
  source: ReadonlyArray<NamedValue>,
  target: ReadonlyArray<NamedValue>,
): ReadonlyArray<ProposedMatch> {
  const claimed = new Set<string>();
  const matches = new Map<string, ProposedMatch>();

  const claim = (sourceId: string, targetId: string, confidence: MatchConfidence) => {
    matches.set(sourceId, { sourceId, targetId, confidence });
    claimed.add(targetId);
  };

  for (const value of source) {
    const hit = target.find(
      (candidate) => !claimed.has(candidate.id) && candidate.name === value.name,
    );
    if (hit !== undefined) claim(value.id, hit.id, "exact");
  }

  for (const value of source) {
    if (matches.has(value.id)) continue;
    const normalized = normalizeMatchName(value.name);
    const hit = target.find(
      (candidate) =>
        !claimed.has(candidate.id) && normalizeMatchName(candidate.name) === normalized,
    );
    if (hit !== undefined) claim(value.id, hit.id, "close");
  }

  for (const value of source) {
    if (matches.has(value.id) || value.category === undefined) continue;
    const candidates = target.filter(
      (candidate) => !claimed.has(candidate.id) && candidate.category === value.category,
    );
    if (candidates.length === 1 && candidates[0] !== undefined) {
      claim(value.id, candidates[0].id, "close");
    }
  }

  return source.map(
    (value) => matches.get(value.id) ?? { sourceId: value.id, targetId: null, confidence: "none" },
  );
}

/** Every source value must have a destination before the move can run. */
export function matchesAreComplete(matches: ReadonlyArray<ProposedMatch>): boolean {
  return matches.every((match) => match.targetId !== null);
}

/** The source values still waiting for a decision, in the order they were given. */
export function unmatchedSourceIds(matches: ReadonlyArray<ProposedMatch>): ReadonlyArray<string> {
  return matches.filter((match) => match.targetId === null).map((match) => match.sourceId);
}

/** Turns the wizard's per-row choices into the id-to-id map the move mutation takes. */
export function matchMapping(
  matches: ReadonlyArray<ProposedMatch>,
): ReadonlyArray<{ readonly from: string; readonly to: string }> {
  return matches
    .filter((match): match is ProposedMatch & { targetId: string } => match.targetId !== null)
    .map((match) => ({ from: match.sourceId, to: match.targetId }));
}
