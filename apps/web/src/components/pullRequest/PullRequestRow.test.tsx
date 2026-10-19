import type { SourcedPullRequestListEntry } from "~/state/pullRequests";
import type { ComponentProps, MouseEvent, ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PullRequestRow } from "./PullRequestRow";

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock("~/localApi", () => ({ readLocalApi: () => ({ shell: { openExternal } }) }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  memo: (component: unknown) => component,
}));

const entry = {
  provider: "github",
  host: "github.com",
  projectId: "project-1",
  environmentId: "remote-environment",
  repository: "example/project",
  number: 42,
  title: "Fix the editor",
  url: "https://github.com/example/project/pull/42",
  author: { login: "octocat", name: null, avatarUrl: null },
  headBranch: "fix-editor",
  baseBranch: "main",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  updatedAt: "2026-09-08T00:00:00Z",
} as SourcedPullRequestListEntry;

function setup() {
  const onSelect = vi.fn();
  const onContextMenu = vi.fn();
  const row = PullRequestRow({
    entry,
    selected: false,
    showProjectTitle: true,
    showProvider: false,
    agentReviewActive: false,
    onSelect,
    onContextMenu,
  }) as ReactElement<ComponentProps<"button">>;
  return { onSelect, onContextMenu, props: row.props };
}

function clickEvent(modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {}) {
  return {
    ctrlKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...modifiers,
  } as unknown as MouseEvent<HTMLButtonElement>;
}

beforeEach(() => vi.clearAllMocks());

describe("pull request row actions", () => {
  it("opens the panel for an ordinary click", () => {
    const { props, onSelect } = setup();
    props.onClick?.(clickEvent());
    expect(onSelect).toHaveBeenCalledWith(entry);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { ctrlKey: true, metaKey: true }])(
    "opens the external PR without selecting it for %j",
    (modifiers) => {
      const { props, onSelect } = setup();
      const event = clickEvent(modifiers);
      props.onClick?.(event);
      expect(openExternal).toHaveBeenCalledExactlyOnceWith(entry.url);
      expect(onSelect).not.toHaveBeenCalled();
      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
    },
  );

  it("opens actions for the clicked row without selecting or opening the PR", () => {
    const { props, onSelect, onContextMenu } = setup();
    const event = clickEvent();
    props.onContextMenu?.(event);
    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith(entry, event);
    expect(onSelect).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });
});
