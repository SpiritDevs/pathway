import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ServerProviderUsageSnapshot } from "./providerUsage.ts";

const decodeSnapshot = Schema.decodeUnknownSync(ServerProviderUsageSnapshot);

const legacySnapshot = {
  instanceId: "codex_default",
  provider: "codex",
  updatedAt: "2026-08-30T00:00:00.000Z",
  limits: [{ window: "Weekly", usedPercent: 42 }],
  usageLines: [],
  source: "chatgpt.com",
  status: "ok",
};

describe("provider usage contracts", () => {
  it("continues to decode snapshots without v2 metadata", () => {
    expect(decodeSnapshot(legacySnapshot)).toEqual(legacySnapshot);
  });

  it("decodes machine-readable window metadata, provider fetch time, and rate-limit time", () => {
    expect(
      decodeSnapshot({
        ...legacySnapshot,
        fetchedAt: "2026-08-29T23:59:00.000Z",
        rateLimitedUntil: "2026-08-30T00:05:00.000Z",
        limits: [
          {
            window: "Sonnet weekly",
            windowKey: "weekly",
            scope: "  Sonnet  ",
            usedPercent: 42,
          },
        ],
      }),
    ).toMatchObject({
      fetchedAt: "2026-08-29T23:59:00.000Z",
      rateLimitedUntil: "2026-08-30T00:05:00.000Z",
      limits: [{ windowKey: "weekly", scope: "Sonnet" }],
    });
  });
});
