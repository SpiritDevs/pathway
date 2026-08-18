import { CompanyId } from "@spiritdevs/contracts/company";
import { describe, expect, it } from "vite-plus/test";

import {
  ALL_COMPANIES_SCOPE,
  activeCompanyIdStorageKey,
  companyReplicasForSelection,
  companyRowsFromRegistryReplicas,
  readActiveCompanyId,
  resolveActiveCompanyId,
  writeActiveCompanyId,
  type ActiveCompanyStorage,
} from "./activeCompany";

const COMPANY_A = CompanyId.make("company-a");
const COMPANY_B = CompanyId.make("company-b");
const COMPANIES = [{ id: COMPANY_A }, { id: COMPANY_B }];

describe("companyRowsFromRegistryReplicas", () => {
  it("preserves personal workspace kind for account-menu decisions", () => {
    const rows = companyRowsFromRegistryReplicas(
      new Map([
        [
          COMPANY_A,
          {
            view: new Map([
              [
                "company-a",
                {
                  entityKind: "company",
                  name: "Corey's Workspace",
                  workspaceKind: "personal",
                  issueKeyPrefix: "COR",
                },
              ],
            ]),
          },
        ],
      ]),
    );

    expect(rows).toEqual([
      {
        id: COMPANY_A,
        name: "Corey's Workspace",
        workspaceKind: "personal",
        issueKeyPrefix: "COR",
      },
    ]);
  });

  it("treats a legacy workspace without a kind as an organization", () => {
    const rows = companyRowsFromRegistryReplicas(
      new Map([
        [
          COMPANY_A,
          {
            view: new Map([
              ["company-a", { entityKind: "company", name: "Acme", issueKeyPrefix: "ACM" }],
            ]),
          },
        ],
      ]),
    );

    expect(rows[0]?.workspaceKind).toBe("organization");
  });
});

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

  it("uses All companies when no preference exists in a multi-company account", () => {
    expect(resolveActiveCompanyId("account-1", COMPANIES, null)).toBeNull();
  });

  it("keeps a sole company selected", () => {
    expect(resolveActiveCompanyId("account-1", [{ id: COMPANY_A }], null)).toBe(COMPANY_A);
  });

  it("preserves a concrete preference independently of the current replica rows", () => {
    expect(resolveActiveCompanyId("account-1", COMPANIES, "company-missing")).toBe(
      "company-missing",
    );
    expect(resolveActiveCompanyId("account-1", [], COMPANY_B)).toBe(COMPANY_B);
  });

  it("keeps explicit All companies distinct from an implicit sole-company fallback", () => {
    expect(
      resolveActiveCompanyId("account-1", [{ id: COMPANY_A }], ALL_COMPANIES_SCOPE),
    ).toBeNull();
  });

  it("returns null for an empty listing or a signed-out scope", () => {
    expect(resolveActiveCompanyId("account-1", [], null)).toBeNull();
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

  it("keeps a stored company selected when its replica is temporarily unavailable", () => {
    const key = activeCompanyIdStorageKey("account-1");
    const { storage, values } = memoryStorage({ [key]: "company-missing" });

    expect(readActiveCompanyId({ scope: "account-1", companies: COMPANIES, storage })).toBe(
      "company-missing",
    );
    expect(values.get(key)).toBe("company-missing");
  });

  it("round-trips an explicit All companies selection", () => {
    const key = activeCompanyIdStorageKey("account-1");
    const { storage, values } = memoryStorage({ [key]: ALL_COMPANIES_SCOPE });

    expect(readActiveCompanyId({ scope: "account-1", companies: COMPANIES, storage })).toBeNull();
    expect(
      writeActiveCompanyId({
        scope: "account-1",
        companies: COMPANIES,
        companyId: null,
        storage,
      }),
    ).toBeNull();
    expect(values.get(key)).toBe(ALL_COMPANIES_SCOPE);
  });

  it("keeps explicit All companies during staggered sole-replica startup", () => {
    const key = activeCompanyIdStorageKey("account-1");
    const { storage, values } = memoryStorage({ [key]: ALL_COMPANIES_SCOPE });

    expect(
      readActiveCompanyId({ scope: "account-1", companies: [{ id: COMPANY_A }], storage }),
    ).toBeNull();
    expect(values.get(key)).toBe(ALL_COMPANIES_SCOPE);
  });

  it("uses but does not persist the implicit sole-company fallback", () => {
    const key = activeCompanyIdStorageKey("account-1");
    const { storage, values } = memoryStorage();

    expect(
      readActiveCompanyId({ scope: "account-1", companies: [{ id: COMPANY_A }], storage }),
    ).toBe(COMPANY_A);
    expect(values.has(key)).toBe(false);
    expect(readActiveCompanyId({ scope: "account-1", companies: COMPANIES, storage })).toBeNull();
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

  it("does not read or write storage while signed out", () => {
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
    expect(reads).toBe(0);
    expect(writes).toBe(0);
  });

  it("reads a concrete selection before company replicas load", () => {
    const key = activeCompanyIdStorageKey("account-1");
    const { storage } = memoryStorage({ [key]: COMPANY_B });

    expect(readActiveCompanyId({ scope: "account-1", companies: [], storage })).toBe(COMPANY_B);
  });
});

describe("companyReplicasForSelection", () => {
  const replicaA = { view: new Map() };
  const replicaB = { view: new Map() };
  const replicas = new Map([
    [COMPANY_A, replicaA],
    [COMPANY_B, replicaB],
  ]);

  it("returns every replica for All companies", () => {
    expect(companyReplicasForSelection(replicas, null)).toBe(replicas);
  });

  it("returns only the selected company's replica", () => {
    expect([...companyReplicasForSelection(replicas, COMPANY_B)]).toEqual([[COMPANY_B, replicaB]]);
  });

  it("returns an empty scope when the selected company is unavailable", () => {
    expect(companyReplicasForSelection(replicas, CompanyId.make("missing")).size).toBe(0);
  });
});
