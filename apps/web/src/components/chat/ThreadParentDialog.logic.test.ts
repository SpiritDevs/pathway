import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadParentCandidates } from "./ThreadParentDialog.logic";

const here = EnvironmentId.make("environment-here");
const elsewhere = EnvironmentId.make("environment-elsewhere");

function thread(
  id: string,
  options: {
    readonly environmentId?: EnvironmentId;
    readonly parent?: string;
    readonly parentEnvironmentId?: EnvironmentId;
    readonly archived?: boolean;
  } = {},
) {
  return {
    id: ThreadId.make(id),
    environmentId: options.environmentId ?? here,
    archivedAt: options.archived ? "2026-01-01T00:00:00.000Z" : null,
    lineage: {
      rootThreadId: ThreadId.make(id),
      parentThreadId: options.parent === undefined ? null : ThreadId.make(options.parent),
      relationshipToParent: null,
      ...(options.parentEnvironmentId === undefined
        ? {}
        : { parentEnvironmentId: options.parentEnvironmentId }),
    },
  };
}

describe("threadParentCandidates", () => {
  it("leaves out the thread, everything beneath it on any environment, and archived threads", () => {
    const threads = [
      thread("target"),
      thread("child", { parent: "target" }),
      thread("remote-grandchild", {
        environmentId: elsewhere,
        parent: "child",
        parentEnvironmentId: here,
      }),
      thread("sibling"),
      thread("archived", { archived: true }),
      thread("same-id-elsewhere", { environmentId: elsewhere }),
    ];

    expect(
      threadParentCandidates(threads, { environmentId: here, threadId: "target" }).map(
        ({ id }) => id,
      ),
    ).toEqual(["sibling", "same-id-elsewhere"]);
  });
});
