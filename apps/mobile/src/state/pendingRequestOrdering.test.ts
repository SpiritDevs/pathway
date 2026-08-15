import { RuntimeRequestId } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sortPendingRequestsOldestFirst } from "./pendingRequestOrdering";

describe("pending request ordering", () => {
  it("shows the oldest request first with a deterministic id tie-break", () => {
    const requests = [
      {
        requestId: RuntimeRequestId.make("request-c"),
        createdAt: "2026-08-12T10:00:02.000Z",
      },
      {
        requestId: RuntimeRequestId.make("request-b"),
        createdAt: "2026-08-12T10:00:01.000Z",
      },
      {
        requestId: RuntimeRequestId.make("request-a"),
        createdAt: "2026-08-12T10:00:01.000Z",
      },
    ];

    expect(sortPendingRequestsOldestFirst(requests).map((request) => request.requestId)).toEqual([
      "request-a",
      "request-b",
      "request-c",
    ]);
    expect(requests[0]?.requestId).toBe("request-c");
  });
});
