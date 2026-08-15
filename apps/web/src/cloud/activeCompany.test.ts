import { CompanyId } from "@spiritdevs/contracts/company";
import { describe, expect, it } from "vite-plus/test";

import {
  activeCompanyIdStorageKey,
  readActiveCompanyId,
  resolveActiveCompanyId,
  writeActiveCompanyId,
  type ActiveCompanyStorage,
} from "./activeCompany";

const COMPANY_A = CompanyId.make("company-a");
const COMPANY_B = CompanyId.make("company-b");
const COMPANIES = [{ id: COMPANY_A }, { id: COMPANY_B }];

function memoryStorage(initial: Readonly<Record<string, string>> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    } satisfies ActiveCompanyStorage,
    values,
  };
}

describe("resolveActiveCompanyId", () => {
  it("keeps a preferred company that remains available", () => {
    expect(resolveActiveCompanyId("account-1", COMPANIES, COMPANY_B)).toBe(COMPANY_B);
  });

  it("falls back to the first company in stable listing order", () => {
    expect(resolveActiveCompanyId("account-1", COMPANIES, "company-missing")).toBe(COMPANY_A);
  });

  it("returns null for an empty listing or a signed-out scope", () => {
    expect(resolveActiveCompanyId("account-1", [], COMPANY_A)).toBeNull();
    expect(resolveActiveCompanyId(null, COMPANIES, COMPANY_A)).toBeNull();
  });
});

describe("active company persistence", () => {
  it("reads selections from account-scoped keys", () => {
    const { storage } = memoryStorage({
      [activeCompanyIdStorageKey("account-1")]: COMPANY_A,
      [activeCompanyIdStorageKey("account-2")]: COMPANY_B,
    });

    expect(readActiveCompanyId({ scope: "account-1", companies: COMPANIES, storage })).toBe(
      COMPANY_A,
    );
    expect(readActiveCompanyId({ scope: "account-2", companies: COMPANIES, storage })).toBe(
      COMPANY_B,
    );
  });

  it("persists the first company when a stored selection is no longer available", () => {
    const key = activeCompanyIdStorageKey("account-1");
    const { storage, values } = memoryStorage({ [key]: "company-missing" });

    expect(readActiveCompanyId({ scope: "account-1", companies: COMPANIES, storage })).toBe(
      COMPANY_A,
    );
    expect(values.get(key)).toBe(COMPANY_A);
  });

  it("persists explicit updates immediately", () => {
    const key = activeCompanyIdStorageKey("account-1");
    const { storage, values } = memoryStorage();

    expect(
      writeActiveCompanyId({
        scope: "account-1",
        companies: COMPANIES,
        companyId: COMPANY_B,
        storage,
      }),
    ).toBe(COMPANY_B);
    expect(values.get(key)).toBe(COMPANY_B);
  });

  it("does not read or write storage while signed out or before companies load", () => {
    let reads = 0;
    let writes = 0;
    const storage: ActiveCompanyStorage = {
      getItem: () => {
        reads += 1;
        return COMPANY_A;
      },
      setItem: () => {
        writes += 1;
      },
    };

    expect(readActiveCompanyId({ scope: null, companies: COMPANIES, storage })).toBeNull();
    expect(readActiveCompanyId({ scope: "account-1", companies: [], storage })).toBeNull();
    expect(reads).toBe(0);
    expect(writes).toBe(0);
  });
});
