import { describe, expect, it } from "vite-plus/test";

import { parseComputerApprovalPrompt } from "./computerApproval.ts";

describe("parseComputerApprovalPrompt", () => {
  it("reads the task consent prompt", () => {
    expect(
      parseComputerApprovalPrompt({
        requestKind: "computer",
        detail: "Allow Computer for this task",
      }),
    ).toEqual({ scope: "task" });
  });

  it("reads the per-app consent prompt, including the server's unnamed-app fallback", () => {
    expect(
      parseComputerApprovalPrompt({
        requestKind: "computer",
        detail: "Allow Computer to use Safari in this task",
      }),
    ).toEqual({ scope: "app", app: "Safari" });
    expect(
      parseComputerApprovalPrompt({
        requestKind: "computer",
        detail: "Allow Computer to use another app in this task",
      }),
    ).toEqual({ scope: "app", app: "another app" });
  });

  it("reads a supervised call with and without display-safe arguments", () => {
    expect(
      parseComputerApprovalPrompt({
        requestKind: "computer",
        detail: 'Computer action needs approval: computer_click {"x":812,"y":344,"label":"Save"}',
      }),
    ).toEqual({
      scope: "call",
      toolName: "computer_click",
      args: { x: 812, y: 344, label: "Save" },
    });
    expect(
      parseComputerApprovalPrompt({
        requestKind: "computer",
        detail: "Computer action needs approval: computer_read_clipboard",
      }),
    ).toEqual({ scope: "call", toolName: "computer_read_clipboard", args: undefined });
  });

  it("keeps the tool when the detail is not a JSON object", () => {
    expect(
      parseComputerApprovalPrompt({
        requestKind: "computer",
        detail: "Computer action needs approval: computer_run [1,2]",
      }),
    ).toEqual({ scope: "call", toolName: "computer_run", args: undefined });
  });

  it("ignores other request kinds and unknown prompts", () => {
    expect(
      parseComputerApprovalPrompt({
        requestKind: "command",
        detail: "Allow Computer for this task",
      }),
    ).toBeNull();
    expect(parseComputerApprovalPrompt({ requestKind: "computer" })).toBeNull();
    expect(
      parseComputerApprovalPrompt({ requestKind: "computer", detail: "Something else" }),
    ).toBeNull();
  });
});
