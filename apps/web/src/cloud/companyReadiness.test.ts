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
    expect(
      companyThreadReadiness(null, replicas, new Map([[company, status]]), {
        phase: "ready",
        companyIds: [company],
      }),
    ).toBe("ready");
  });
});

it("does not declare All ready before undispatched company engines bootstrap", () => {
  const statuses = new Map([[company, status]]);
  expect(companyThreadReadiness(null, replicas, statuses, { phase: "loading" })).toBe("loading");
  expect(
    companyThreadReadiness(null, replicas, statuses, {
      phase: "ready",
      companyIds: [company, other],
    }),
  ).toBe("loading");
  expect(
    companyThreadReadiness(
      null,
      new Map([...replicas, [other, { view: new Map() }]]),
      new Map([...statuses, [other, status]]),
      { phase: "ready", companyIds: [company, other] },
    ),
  ).toBe("ready");
  expect(
    companyThreadReadiness(null, new Map(), new Map(), { phase: "ready", companyIds: [] }),
  ).toBe("ready");
});

it("shows discovery failure for an unbootstrapped view, then recovers on retry", () => {
  for (const selected of [null, company]) {
    expect(companyThreadReadiness(selected, new Map(), new Map(), { phase: "error" })).toBe(
      "error",
    );
    expect(companyThreadReadiness(selected, new Map(), new Map(), { phase: "loading" })).toBe(
      "loading",
    );
    expect(
      companyThreadReadiness(selected, replicas, new Map([[company, status]]), {
        phase: "ready",
        companyIds: [company],
      }),
    ).toBe("ready");
  }
  expect(
    companyThreadReadiness(company, replicas, new Map([[company, status]]), { phase: "error" }),
  ).toBe("ready");
});
