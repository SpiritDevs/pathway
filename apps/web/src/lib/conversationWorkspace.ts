import { normalizeProjectPathForComparison } from "@spiritdevs/shared/path";

/** Git's ancestor discovery must not turn an isolated conversation folder into the parent repo. */
export function isConversationRepositoryRoot(
  conversationPath: string | null | undefined,
  repositoryRoot: string | null | undefined,
): boolean {
  return Boolean(
    conversationPath &&
    repositoryRoot &&
    normalizeProjectPathForComparison(conversationPath) ===
      normalizeProjectPathForComparison(repositoryRoot),
  );
}

/** Prefer the original folder when it contains Git work that could block deletion. */
export function resolveConversationReviewWorkspace(input: {
  projectPath: string | null | undefined;
  conversationPath: string | null | undefined;
  selectedPath: string | null;
  conversationGitStatus:
    | {
        isRepo: boolean;
        hasWorkingTreeChanges: boolean;
        aheadCount: number;
        hasUpstream: boolean;
      }
    | null
    | undefined;
}): string | null {
  const { projectPath, conversationPath, selectedPath, conversationGitStatus } = input;
  if (selectedPath && (selectedPath === projectPath || selectedPath === conversationPath))
    return selectedPath;
  if (
    conversationPath &&
    conversationGitStatus?.isRepo &&
    (conversationGitStatus.hasWorkingTreeChanges ||
      conversationGitStatus.aheadCount > 0 ||
      !conversationGitStatus.hasUpstream)
  )
    return conversationPath;
  return projectPath ?? conversationPath ?? null;
}
