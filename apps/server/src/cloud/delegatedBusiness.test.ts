import { describe, expect, it } from "vite-plus/test";
import { businessRequest } from "./delegatedBusiness.ts";
import { checkWorkerToolAccess } from "./orchestratorWorkerAuthority.ts";

const origin = { companyId: "company", orchestratorId: "chief", commandId: "assignment" };
describe("delegated business routing", () => {
  it("binds mail and timer requests to the runtime assignment origin", () => {
    expect(
      businessRequest(origin, {
        kind: "mail.send",
        input: { operation: "send", draftId: "draft" },
      }),
    ).toEqual({
      name: "mail:requestSend",
      mutation: true,
      args: { companyId: "company", delegatedOrigin: origin, draftId: "draft" },
    });
    expect(businessRequest(origin, { kind: "time.read", input: { operation: "list" } })).toEqual({
      name: "timeTracking:listMine",
      mutation: false,
      args: { delegatedOrigin: origin },
    });
  });
  it("keeps mail and time writes separate from read privileges", () => {
    const access = { allowed: true, capabilities: ["mail.read", "time.read"] };
    expect(checkWorkerToolAccess(access, "pathway_mail_read", {})).toBeNull();
    expect(checkWorkerToolAccess(access, "pathway_time_read", {})).toBeNull();
    expect(checkWorkerToolAccess(access, "pathway_mail_write", {})).toContain("permissions");
    expect(checkWorkerToolAccess(access, "pathway_time_write", {})).toContain("permissions");
  });
});
