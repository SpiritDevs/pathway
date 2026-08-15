import { ThreadId } from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeRawThreadShell } from "../../test-fixtures";
import { mergeRelationshipThreadShells } from "./threadRelationships";

describe("thread relationship shells", () => {
  it("deduplicates archived and live lineage nodes with live state winning", () => {
    const threadId = ThreadId.make("thread-related");
    const archived = makeRawThreadShell({
      id: threadId,
      title: "Archived title",
      archivedAt: DateTime.makeUnsafe("2026-08-12T09:00:00.000Z"),
    });
    const live = makeRawThreadShell({ id: threadId, title: "Live title", archivedAt: null });

    expect(mergeRelationshipThreadShells([live], [archived])).toEqual([live]);
  });
});
