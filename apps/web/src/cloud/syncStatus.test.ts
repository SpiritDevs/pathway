import { CompanyId } from "@spiritdevs/contracts/company";
import { beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { appAtomRegistry, resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import { companySyncStatusesAtom, publishCompanySyncStatus } from "./syncStatus";
import type { CompanySyncStatus } from "./syncStatus.logic";

const COMPANY_ID = CompanyId.make("company-a");
const STATUS: CompanySyncStatus = {
  phase: "live",
  bootstrapComplete: true,
  pendingCount: 0,
  pendingKinds: [],
  blockedCount: 0,
  rejectedCount: 0,
  quarantinedCount: 0,
  lastError: null,
};

describe("publishCompanySyncStatus", () => {
  beforeEach(() => resetAppAtomRegistryForTests());

  it.effect("publishes updates per company and removes them on teardown", () =>
    Effect.gen(function* () {
      yield* publishCompanySyncStatus(COMPANY_ID, STATUS);
      expect(appAtomRegistry.get(companySyncStatusesAtom).get(COMPANY_ID)).toEqual(STATUS);

      const reconnecting = { ...STATUS, phase: "reconnecting" as const };
      yield* publishCompanySyncStatus(COMPANY_ID, reconnecting);
      expect(appAtomRegistry.get(companySyncStatusesAtom).get(COMPANY_ID)).toEqual(reconnecting);

      yield* publishCompanySyncStatus(COMPANY_ID, null);
      expect(appAtomRegistry.get(companySyncStatusesAtom)).toEqual(new Map());
    }),
  );
});
