import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { OrchestratorWorkItem } from "@spiritdevs/contracts/aiOrchestrator";
import { OrchestratorAvatar, avatarWorkStatus } from "./OrchestratorAvatar";
const contact = { id: "chief", name: "Chief", color: "blue", status: "active" as const };
const work = (status: OrchestratorWorkItem["status"], updatedAt: number): OrchestratorWorkItem => ({
  id: `${status}-${updatedAt}`,
  title: "Task",
  orchestratorId: "chief",
  environmentId: "env",
  projectId: null,
  threadId: null,
  status,
  detail: "",
  updatedAt,
});

describe("orchestrator avatar presentation", () => {
  it("upgrades legacy identity without requiring configuration and keeps its color", () => {
    const html = renderToStaticMarkup(<OrchestratorAvatar contact={contact} />);
    expect(html).toContain("var(--color-blue-500)");
    expect(html).toContain("<svg");
    expect(html).not.toContain("<button");
  });
  it("keeps work status accessible independently of a pleased expression", () => {
    const html = renderToStaticMarkup(
      <OrchestratorAvatar contact={contact} expression="pleased" status="blocked" interactive />,
    );
    expect(html).toContain('aria-label="Needs attention"');
    expect(html).toContain('aria-label="Greet Chief"');
    expect(html.match(/<button/g)).toHaveLength(1);
  });
  it("ignores expired leases and unrelated work while preserving actual active work", () => {
    expect(avatarWorkStatus(contact, [], [{ id: "chief", expiresAt: 0 }])).toBeUndefined();
    expect(
      avatarWorkStatus(contact, [], [{ id: "someone-else", expiresAt: Number.MAX_SAFE_INTEGER }]),
    ).toBeUndefined();
    expect(avatarWorkStatus(contact, [work("failed", 10), work("working", 1)])).toBe("working");
    expect(avatarWorkStatus(contact, [work("failed", 10), work("completed", 20)])).toBe(
      "completed",
    );
    expect(avatarWorkStatus({ ...contact, status: "paused" }, [work("working", 20)])).toBe(
      "paused",
    );
  });
});
