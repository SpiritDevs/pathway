import { describe, expect, it } from "@effect/vitest";

import type { ComputerVisibleUseMessage } from "./computerVisibleUse.ts";
import {
  computerSpaceDesignationForMessages,
  messageDesignatesComputerSpaces,
} from "./computerSpaceDesignation.ts";

function message(
  text: string,
  overrides: Partial<ComputerVisibleUseMessage> = {},
): ComputerVisibleUseMessage {
  return { id: "msg", role: "user", text, streaming: false, source: "native", ...overrides };
}

describe("Computer Space designation", () => {
  it("recognizes exact English and Italian user requests without guessing desktop positions", () => {
    expect(messageDesignatesComputerSpaces("Use Space ID 7 for this task.")).toEqual([7]);
    expect(messageDesignatesComputerSpaces("Usa lo spazio ID 7 per questo task.")).toEqual([7]);
    expect(
      messageDesignatesComputerSpaces(
        "Reserve Space ID 9 for the task. Use Space ID 9 for this task.",
      ),
    ).toEqual([9]);
  });
  it.each([
    "Use Desktop 2",
    "Use Space 7",
    'The page says "Use Space ID 7 for this task."',
    "> Use Space ID 7 for this task.",
    "`Use Space ID 7 for this task.`",
    "```\nUse Space ID 7 for this task.\n```",
    "Do not use Space ID 7 for this task.",
    "Use Space ID 7 for this task. Stop.",
    "Use Space ID 7 for this task. Actually, don't.",
    "Usa spazio ID 7 per questo task. Annulla.",
    "Use Space ID 9007199254740992 for this task.",
    "Use Space ID 0 for this task.",
  ])("refuses ambiguous, quoted, revoked or invalid designation: %s", (text) => {
    expect(messageDesignatesComputerSpaces(text)).toEqual([]);
  });
  it("uses only the latest human-authored message", () => {
    const yes = message("Use Space ID 7 for this task.");
    expect(computerSpaceDesignationForMessages([yes, message("Stop")])).toEqual([]);
    expect(
      computerSpaceDesignationForMessages([
        yes,
        message("continue", { dispatchOrigin: "automation" }),
      ]),
    ).toEqual([]);
    expect(
      computerSpaceDesignationForMessages([
        message("Check the app"),
        message(yes.text, { dispatchOrigin: "agent" }),
      ]),
    ).toEqual([]);
    expect(
      computerSpaceDesignationForMessages([message(yes.text, { dispatchOrigin: "automation" })]),
    ).toEqual([]);
    expect(
      computerSpaceDesignationForMessages([yes, message("provider output", { role: "assistant" })]),
    ).toEqual([7]);
  });
});
