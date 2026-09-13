import { describe, it, expect } from "vite-plus/test";
import { checkWorkerToolAccess } from "./orchestratorWorkerAuthority.ts";

describe("delegated worker privileges", () => {
  it("blocks writes while retaining authorized task reads", () => {
    const access = { allowed: true, capabilities: ["tasks.read", "threads.read"] };
    expect(checkWorkerToolAccess(access, "issues_get", {})).toBeNull();
    expect(checkWorkerToolAccess(access, "issues_update", {})).toContain("permissions");
    expect(checkWorkerToolAccess(access, "email_get", {})).toContain("permissions");
    expect(checkWorkerToolAccess({ ...access, allowed: false }, "issues_get", {})).toContain(
      "permissions",
    );
  });
  it("does not allow an unknown tool or a detached launch to lose assignment limits", () => {
    const access = { allowed: true, capabilities: ["threads.delegate", "schedules.manage"] };
    expect(checkWorkerToolAccess(access, "delegate_task", {})).toBeNull();
    expect(
      checkWorkerToolAccess(access, "delegate_task", { targetEnvironmentId: "another-host" }),
    ).toContain("coordinating orchestrator");
    expect(checkWorkerToolAccess(access, "schedule_task", {})).toContain("work limits");
    expect(checkWorkerToolAccess(access, "future_tool", {})).toContain("permissions");
  });
});
