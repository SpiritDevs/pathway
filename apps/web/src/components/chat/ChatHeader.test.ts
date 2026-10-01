import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadBreadcrumbAncestors } from "./ChatHeader";

const environmentId = EnvironmentId.make("environment-local");

function thread(input: {
  readonly id: string;
  readonly title: string;
  readonly parentId?: string | null;
  readonly forkParentId?: string;
  /** A fork that was later moved under another thread or to the threads list. */
  readonly moved?: boolean;
  readonly environment?: string;
  readonly parentEnvironment?: string;
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
      relationshipToParent:
        input.forkParentId === undefined || input.moved ? null : ("fork" as const),
      ...(input.parentEnvironment === undefined
        ? {}
        : { parentEnvironmentId: EnvironmentId.make(input.parentEnvironment) }),
    },
  };
}

describe("thread header breadcrumb ancestry", () => {
  it("orders every available ancestor from the root to the immediate parent", () => {
    const root = thread({ id: "root", title: "Root" });
    const child = thread({ id: "child", title: "Child", parentId: "root" });
    const grandchild = thread({ id: "grandchild", title: "Grandchild", parentId: "child" });

    expect(resolveThreadBreadcrumbAncestors(grandchild, [child, grandchild, root])).toEqual([
      { id: root.id, title: "Root", environmentId: root.environmentId },
      { id: child.id, title: "Child", environmentId: child.environmentId },
    ]);
  });

  it("stops safely at missing parents and lineage cycles", () => {
    const child = thread({ id: "child", title: "Child", parentId: "missing" });
    expect(resolveThreadBreadcrumbAncestors(child, [child])).toEqual([]);

    const first = thread({ id: "first", title: "First", parentId: "second" });
    const second = thread({ id: "second", title: "Second", parentId: "first" });
    expect(resolveThreadBreadcrumbAncestors(first, [first, second])).toEqual([
      { id: second.id, title: "Second", environmentId: second.environmentId },
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
      { id: forkParent.id, title: "Fork parent", environmentId: forkParent.environmentId },
    ]);
  });

  it("follows a parent on another environment", () => {
    const remoteParent = thread({ id: "parent", title: "On the laptop", environment: "laptop" });
    const child = thread({
      id: "child",
      title: "Child",
      parentId: "parent",
      parentEnvironment: "laptop",
    });

    expect(resolveThreadBreadcrumbAncestors(child, [remoteParent, child])).toEqual([
      { id: remoteParent.id, title: "On the laptop", environmentId: remoteParent.environmentId },
    ]);
  });

  it("follows lineage once a fork has been moved under another thread", () => {
    const newParent = thread({ id: "new-parent", title: "New parent" });
    const forkParent = thread({ id: "fork-parent", title: "Fork parent" });
    const moved = thread({
      id: "moved",
      title: "Moved",
      parentId: "new-parent",
      forkParentId: "fork-parent",
      moved: true,
    });

    expect(resolveThreadBreadcrumbAncestors(moved, [newParent, forkParent, moved])).toEqual([
      { id: newParent.id, title: "New parent", environmentId: newParent.environmentId },
    ]);
  });

  it("does not cross environment boundaries when thread ids collide", () => {
    const root = thread({ id: "root", title: "Local root" });
    const remoteRoot = thread({ id: "root", title: "Remote root", environment: "remote" });
    const child = thread({ id: "child", title: "Child", parentId: "root" });

    expect(resolveThreadBreadcrumbAncestors(child, [remoteRoot, root, child])).toEqual([
      { id: root.id, title: "Local root", environmentId: root.environmentId },
    ]);
  });
});
