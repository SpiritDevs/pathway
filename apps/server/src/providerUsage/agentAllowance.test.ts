import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderUsageSnapshot,
} from "@spiritdevs/contracts";
import { allowanceReport } from "./agentAllowance.ts";
const provider = {
  instanceId: ProviderInstanceId.make("codex-work"),
  driver: ProviderDriverKind.make("codex"),
};
const now = Date.parse("2026-09-13T09:00:00Z");
const snapshot: ServerProviderUsageSnapshot = {
  instanceId: provider.instanceId,
  provider: "codex",
  source: "provider",
  status: "ok",
  fetchedAt: "2026-09-13T09:00:00Z",
  updatedAt: "2026-09-13T09:00:00Z",
  accountKey: "hashed-account",
  limits: [
    {
      window: "Weekly",
      usedPercent: 40,
      fetchedAt: "2026-09-13T09:00:00Z",
      resetsAt: "2026-09-20T09:00:00Z",
    },
  ],
  usageLines: [],
};
describe("agent allowance reports", () => {
  it("preserves actual account quota, identity, and independent window freshness", () => {
    const report = allowanceReport(provider, snapshot, now);
    expect(report.snapshot?.accountKey).toBe("hashed-account");
    expect(report.snapshot?.limits[0]?.usedPercent).toBe(40);
    expect(report.snapshot?.stale).toBe(false);
    expect(report.freshness).toBe("fresh");
    const partial = {
      ...snapshot,
      limits: [{ ...snapshot.limits[0]!, fetchedAt: "2026-09-13T08:30:00Z" }],
    };
    expect(allowanceReport(provider, partial, now).detail).toContain("quota windows");
    expect(allowanceReport(provider, partial, now).freshness).toBe("stale");
    expect(allowanceReport(provider, snapshot, now + 90_000).freshness).toBe("stale");
    expect(allowanceReport(provider, { ...snapshot, fetchedAt: "invalid" }, now).freshness).toBe(
      "unknown",
    );
    expect(allowanceReport(provider, snapshot, now + 300_000).snapshot?.stale).toBe(true);
  });
  it("never invents capacity or cross-environment identity for unsupported or unavailable data", () => {
    expect(
      allowanceReport({ ...provider, driver: ProviderDriverKind.make("grok") }, null, now),
    ).toMatchObject({ status: "unsupported", snapshot: null });
    expect(
      allowanceReport(
        provider,
        {
          ...snapshot,
          status: "needs-auth",
          accountKey: undefined,
          fetchedAt: undefined,
          limits: [],
        },
        now,
      ),
    ).toMatchObject({ status: "needs-auth", snapshot: { stale: true } });
    expect(allowanceReport(provider, { ...snapshot, accountKey: undefined }, now).detail).toContain(
      "No stable",
    );
  });
});
