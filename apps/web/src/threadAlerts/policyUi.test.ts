import { describe, expect, it } from "vite-plus/test";
import { threadPolicyView, bulkAlertChoices } from "./policyUi";
import {
  searchSettings,
  SETTINGS_NAV_GROUPS,
  settingsPathIsVisibleForWorkspace,
} from "../components/settings/settingsSearch";
import { BUILT_IN_KEYBINDING_COMMANDS } from "@spiritdevs/contracts";
import { DEFAULT_KEYBINDINGS } from "@spiritdevs/shared/keybindings";

describe("alert controls", () => {
  it("shows explicit off even while every parent is enabled", () => {
    const view = threadPolicyView(
      [
        {
          scopeKind: "global",
          scopeKey: "global",
          choices: { completion: true, permission: true, input: true, failure: true },
        },
        {
          scopeKind: "thread",
          scopeKey: "thread",
          choices: { completion: false, permission: false, input: false, failure: false },
        },
      ],
      "project",
      "thread",
    );
    expect(view.state).toBe("off");
    expect(view.explicit).toBe(true);
    expect(bulkAlertChoices(view.effective)).toEqual({
      completion: true,
      permission: true,
      input: true,
      failure: true,
    });
  });
  it("has one navigation entry available to every workspace and searchable sound and quiet hours", () => {
    expect(
      SETTINGS_NAV_GROUPS.flatMap((group) => group.paths).filter(
        (path) => path === "/settings/notifications",
      ),
    ).toHaveLength(1);
    for (const workspace of ["profile", "personal", "organization"] as const)
      expect(settingsPathIsVisibleForWorkspace("/settings/notifications", workspace)).toBe(true);
    expect(
      searchSettings("quiet hours").some((item) => item.to === "/settings/notifications"),
    ).toBe(true);
    expect(searchSettings("sound").some((item) => item.to === "/settings/notifications")).toBe(
      true,
    );
  });
  it("exposes a bindable toggle without assigning a shortcut", () => {
    expect(BUILT_IN_KEYBINDING_COMMANDS).toContain("threadAlerts.toggle");
    expect(DEFAULT_KEYBINDINGS.some((binding) => binding.command === "threadAlerts.toggle")).toBe(
      false,
    );
  });
});

it("inherits global and thread alert choices for conversations without a project", () => {
  const view = threadPolicyView(
    [
      { scopeKind: "global", scopeKey: "global", choices: { completion: true, failure: true } },
      { scopeKind: "project", scopeKey: "null", choices: { completion: false } },
      { scopeKind: "thread", scopeKey: "conversation", choices: { failure: false } },
    ],
    null,
    "conversation",
  );
  expect(view.effective.completion).toBe(true);
  expect(view.effective.failure).toBe(false);
});
