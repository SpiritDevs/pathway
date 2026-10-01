import type { PromptStashEntry } from "../../promptStashStore";

const SNIPPET_MAX_CHARS = 90;

export function stashEntrySnippet(entry: PromptStashEntry): string {
  const text = entry.prompt.trim().replace(/\s+/g, " ");
  if (text) {
    return text.length > SNIPPET_MAX_CHARS ? `${text.slice(0, SNIPPET_MAX_CHARS)}…` : text;
  }
  const count =
    entry.attachments.length +
    entry.droppedImageNames.length +
    (entry.unreadableImageNames?.length ?? 0) +
    (entry.pendingImageCount ?? 0);
  return count > 0 ? `${count} attachment${count === 1 ? "" : "s"}` : "Empty prompt";
}

export function stashEntryMatchesQuery(entry: PromptStashEntry, query: string): boolean {
  return `${entry.prompt} ${stashEntrySnippet(entry)} ${entry.attachments.map((attachment) => attachment.name).join(" ")}`
    .toLowerCase()
    .includes(query.trim().toLowerCase());
}

/** Restoring adds to the draft without replacing unfinished work. */
export function appendStashedPrompt(currentPrompt: string, prompt: string): string {
  if (prompt.length === 0) return currentPrompt;
  return currentPrompt.trim().length ? `${currentPrompt.replace(/\s+$/, "")}\n\n${prompt}` : prompt;
}
