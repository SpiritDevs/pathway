import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export interface BrowserThreadOption {
  readonly key: string;
  readonly environmentId: EnvironmentThreadShell["environmentId"];
  readonly threadId: EnvironmentThreadShell["id"];
  readonly projectId: EnvironmentThreadShell["projectId"];
  readonly title: string;
  readonly hasOpenBrowser: boolean;
}

export function browserThreadOptions(
  threads: readonly EnvironmentThreadShell[],
  previewThreadKeys: ReadonlySet<string>,
): readonly BrowserThreadOption[] {
  return threads
    .filter((thread) => thread.deletedAt === null && thread.archivedAt === null)
    .map((thread) => {
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      return {
        key,
        environmentId: thread.environmentId,
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        hasOpenBrowser: previewThreadKeys.has(key),
        updatedAt: thread.updatedAt,
      };
    })
    .toSorted(
      (left, right) =>
        Number(right.hasOpenBrowser) - Number(left.hasOpenBrowser) ||
        right.updatedAt.localeCompare(left.updatedAt),
    )
    .map(({ updatedAt: _updatedAt, ...option }) => option);
}

export function resolveBrowserThreadOption(
  options: readonly BrowserThreadOption[],
  preferredKey: string,
): BrowserThreadOption | null {
  return options.find(({ key }) => key === preferredKey) ?? options[0] ?? null;
}
