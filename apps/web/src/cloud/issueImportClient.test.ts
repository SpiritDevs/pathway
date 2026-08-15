import type { CompanyId } from "@spiritdevs/contracts/company";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  makeIssueImportClient,
  mapIssueImportClientError,
  type IssueImportConvexClient,
} from "./issueImportClient";

const COMPANY_ID = "company-1" as CompanyId;

function fakeClient() {
  const calls: Array<{ readonly kind: string; readonly name: string; readonly args: unknown }> = [];
  let update: ((value: unknown) => void) | null = null;
  const unsubscribe = vi.fn();
  const client: IssueImportConvexClient = {
    mutation: async (reference, args) => {
      calls.push({ kind: "mutation", name: getFunctionName(reference), args });
      return { id: "run-1" };
    },
    onUpdate: (reference, args, callback) => {
      calls.push({ kind: "query", name: getFunctionName(reference), args });
      update = callback;
      return unsubscribe;
    },
    setAuth: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  return { calls, client, emit: (value: unknown) => update?.(value), unsubscribe };
}

describe("issue import member client", () => {
  it("authenticates and calls start, get, and abandon directly", async () => {
    const fake = fakeClient();
    const fetchToken = vi.fn(async () => "token");
    const member = makeIssueImportClient({
      convexUrl: "https://example.convex.cloud",
      fetchToken,
      client: fake.client,
    });
    const onValue = vi.fn();

    await member.start({
      companyId: COMPANY_ID,
      id: "run-1",
      sourceEnvironmentId: "environment-1",
      selectedIssueKeyPrefix: "ISS",
    });
    const unsubscribe = member.subscribeRun(
      { companyId: COMPANY_ID, runId: "run-1" },
      onValue,
      vi.fn(),
    );
    fake.emit({ id: "run-1", state: "applying" });
    await member.abandon({ companyId: COMPANY_ID, runId: "run-1" });

    expect(fake.client.setAuth).toHaveBeenCalledWith(fetchToken);
    expect(fake.calls).toEqual([
      {
        kind: "mutation",
        name: "issueImport:start",
        args: {
          companyId: COMPANY_ID,
          id: "run-1",
          sourceEnvironmentId: "environment-1",
          selectedIssueKeyPrefix: "ISS",
        },
      },
      {
        kind: "query",
        name: "issueImport:get",
        args: { companyId: COMPANY_ID, runId: "run-1" },
      },
      {
        kind: "mutation",
        name: "issueImport:abandon",
        args: { companyId: COMPANY_ID, runId: "run-1" },
      },
    ]);
    expect(onValue).toHaveBeenCalledWith({ id: "run-1", state: "applying" });
    unsubscribe();
    expect(fake.unsubscribe).toHaveBeenCalledOnce();
  });

  it("maps company.manage refusals to settings copy", () => {
    const error = mapIssueImportClientError(
      new ConvexError({ code: "permission-denied", message: "Missing permission." }),
    );
    expect(error.code).toBe("permission-denied");
    expect(error.message).toBe("You need company.manage permission to migrate issues.");
  });
});
