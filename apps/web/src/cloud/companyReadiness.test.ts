import { CompanyId } from "@spiritdevs/contracts/company";
import { describe, expect, it } from "vite-plus/test";
import { companyThreadReadiness } from "./companyReadiness";
import type { CompanySyncStatus } from "./syncStatus.logic";

const company = CompanyId.make("company-a");
const other = CompanyId.make("company-b");
const status: CompanySyncStatus = {
  phase: "live",
  bootstrapComplete: true,
  pendingCount: 0,
  pendingKinds: [],
  blockedCount: 0,
  rejectedCount: 0,
  quarantinedCount: 0,
  lastError: null,
};
const replicas = new Map([[company, { view: new Map() }]]);

describe("company thread readiness", () => {
  it("waits for ownership bootstrap, then accepts a truly empty company", () => {
    expect(companyThreadReadiness(company, new Map(), new Map())).toBe("loading");
    expect(
      companyThreadReadiness(
        company,
        replicas,
        new Map([[company, { ...status, phase: "bootstrapping", bootstrapComplete: false }]]),
      ),
    ).toBe("loading");
    expect(companyThreadReadiness(company, replicas, new Map([[company, status]]))).toBe("ready");
  });
  it("does not borrow another company's readiness", () => {
    expect(companyThreadReadiness(other, replicas, new Map([[company, status]]))).toBe("loading");
  });
  it("retains a complete offline replica but exposes a failure without one", () => {
    const reconnecting = { ...status, phase: "reconnecting" as const };
    expect(companyThreadReadiness(company, replicas, new Map([[company, reconnecting]]))).toBe(
      "ready",
    );
    expect(companyThreadReadiness(company, new Map(), new Map([[company, reconnecting]]))).toBe(
      "error",
    );
  });
  it("waits for all company bootstraps in All companies", () => {
    expect(companyThreadReadiness(null, new Map(), new Map())).toBe("loading");
    expect(
      companyThreadReadiness(
        null,
        replicas,
        new Map([
          [company, status],
          [other, { ...status, bootstrapComplete: false }],
        ]),
      ),
    ).toBe("loading");
    expect(companyThreadReadiness(null, replicas, new Map([[company, status]]))).toBe("ready");
  });
});
