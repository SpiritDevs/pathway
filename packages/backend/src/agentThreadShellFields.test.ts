import { CloudAgentThreadShell } from "@spiritdevs/contracts/cloudProject";
import { describe, expect, it } from "vite-plus/test";

import { AGENT_THREAD_SHELL_FIELDS } from "../convex/agentThreads.ts";

describe("agent thread shell allowlist", () => {
  it("accepts every field an environment can publish", () => {
    // The upsert mutation rejects shells containing any key outside the
    // allowlist, so a shell field added to the contracts without updating
    // AGENT_THREAD_SHELL_FIELDS silently breaks all thread publication.
    const published = Object.keys(CloudAgentThreadShell.fields);
    const missing = published.filter((field) => !AGENT_THREAD_SHELL_FIELDS.has(field));
    expect(missing).toEqual([]);
  });
});
