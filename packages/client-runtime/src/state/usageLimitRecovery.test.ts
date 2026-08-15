import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isUsageLimitFailure,
  parseUsageLimitResetAt,
  resolveUsageLimitResetAt,
} from "./usageLimitRecovery.ts";

describe("usage limit recovery", () => {
  it("recognizes allowance failures without classifying unrelated provider errors", () => {
    expect(
      isUsageLimitFailure({
        class: "provider_error",
        message: "You've hit your session limit · resets 9:50pm (Australia/Sydney)",
        code: null,
        retryable: false,
      }),
    ).toBe(true);
    expect(
      isUsageLimitFailure({
        class: "provider_error",
        message: "Request failed.",
        code: "rate_limit_exceeded",
        retryable: null,
      }),
    ).toBe(true);
    expect(
      isUsageLimitFailure({
        class: "validation_error",
        message: "Invalid reasoning effort.",
        code: "invalid_request",
        retryable: false,
      }),
    ).toBe(false);
  });

  it("parses a provider reset clock in its named timezone", () => {
    expect(
      parseUsageLimitResetAt(
        "You've hit your session limit · resets 9:50pm (Australia/Sydney)",
        Date.parse("2026-08-15T09:22:00.000Z"),
      ),
    ).toBe("2026-08-15T11:50:00.000Z");
  });

  it("rolls a clock reset into the next local day after the time passes", () => {
    expect(
      parseUsageLimitResetAt(
        "Session limit reached; resets 9:50pm (Australia/Sydney)",
        Date.parse("2026-08-15T12:22:00.000Z"),
      ),
    ).toBe("2026-08-16T11:50:00.000Z");
  });

  it("prefers the exhausted usage window over a message fallback", () => {
    expect(
      resolveUsageLimitResetAt({
        failureMessage: "Usage limit reached; resets in 15 minutes",
        nowMs: Date.parse("2026-08-15T09:00:00.000Z"),
        snapshot: {
          instanceId: ProviderInstanceId.make("codex"),
          provider: "codex",
          updatedAt: "2026-08-15T09:00:00.000Z",
          limits: [
            {
              window: "Weekly",
              usedPercent: 40,
              resetsAt: "2026-08-16T09:00:00.000Z",
            },
            {
              window: "Session",
              usedPercent: 100,
              resetsAt: "2026-08-15T10:00:00.000Z",
            },
          ],
          usageLines: [],
          source: "test",
          status: "ok",
        },
      }),
    ).toBe("2026-08-15T10:00:00.000Z");
  });
});
