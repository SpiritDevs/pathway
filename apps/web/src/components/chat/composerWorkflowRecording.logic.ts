/**
 * Draft edits for Record a skill's hand-off. The skill prompt is appended
 * after the user's draft and recognized later by exact text, so a reload
 * never appends it twice and Discard can take back only that prompt.
 */
export function appendWorkflowSkillPrompt(draft: string, skillPrompt: string): string {
  if (draft.includes(skillPrompt)) return draft;
  const kept = draft.trimEnd();
  return kept ? `${kept}\n\n${skillPrompt}` : skillPrompt;
}

/** Removes the exact hand-off prompt and its separator, keeping everything else. */
export function removeWorkflowSkillPrompt(draft: string, skillPrompt: string): string {
  if (!draft.includes(skillPrompt)) return draft;
  const separated = `\n\n${skillPrompt}`;
  const next = draft.includes(separated)
    ? draft.replace(separated, "")
    : draft.replace(skillPrompt, "");
  return next.trim() ? next : "";
}
