import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadBreadcrumbAncestors } from "./ChatHeader";

const environmentId = EnvironmentId.make("environment-local");

function thread(input: {
  readonly id: string;
  readonly title: string;
  readonly parentId?: string | null;
  readonly forkParentId?: string;
  readonly environment?: string;
}) {
  return {
    id: ThreadId.make(input.id),
    title: input.title,
    environmentId: EnvironmentId.make(input.environment ?? environmentId),
    forkedFrom:
      input.forkParentId === undefined
        ? null
        : { type: "run", threadId: ThreadId.make(input.forkParentId) },
    lineage: {
      parentThreadId:
        input.parentId === undefined || input.parentId === null
          ? null
          : ThreadId.make(input.parentId),
    },
  };
}

describe("thread header breadcrumb ancestry", () => {
  it("orders every available ancestor from the root to the immediate parent", () => {
    const root = thread({ id: "root", title: "Root" });
    const child = thread({ id: "child", title: "Child", parentId: "root" });
    const grandchild = thread({ id: "grandchild", title: "Grandchild", parentId: "child" });

    expect(resolveThreadBreadcrumbAncestors(grandchild, [child, grandchild, root])).toEqual([
      { id: root.id, title: "Root" },
      { id: child.id, title: "Child" },
    ]);
  });

  it("stops safely at missing parents and lineage cycles", () => {
    const child = thread({ id: "child", title: "Child", parentId: "missing" });
    expect(resolveThreadBreadcrumbAncestors(child, [child])).toEqual([]);

    const first = thread({ id: "first", title: "First", parentId: "second" });
    const second = thread({ id: "second", title: "Second", parentId: "first" });
    expect(resolveThreadBreadcrumbAncestors(first, [first, second])).toEqual([
      { id: second.id, title: "Second" },
    ]);
  });

  it("uses a fork's source run when it is more specific than lineage metadata", () => {
    const lineageParent = thread({ id: "lineage-parent", title: "Lineage parent" });
    const forkParent = thread({ id: "fork-parent", title: "Fork parent" });
    const child = thread({
      id: "child",
      title: "Child",
      parentId: "lineage-parent",
      forkParentId: "fork-parent",
    });

    expect(resolveThreadBreadcrumbAncestors(child, [lineageParent, forkParent, child])).toEqual([
      { id: forkParent.id, title: "Fork parent" },
    ]);
  });

  it("does not cross environment boundaries when thread ids collide", () => {
    const root = thread({ id: "root", title: "Local root" });
    const remoteRoot = thread({ id: "root", title: "Remote root", environment: "remote" });
    const child = thread({ id: "child", title: "Child", parentId: "root" });

    expect(resolveThreadBreadcrumbAncestors(child, [remoteRoot, root, child])).toEqual([
      { id: root.id, title: "Local root" },
    ]);
  });
});
