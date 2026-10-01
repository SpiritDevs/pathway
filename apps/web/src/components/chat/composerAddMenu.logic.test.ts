import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ServerProviderSkill } from "@spiritdevs/contracts";
import { applyComposerGoalIntent, composerAddSkillItems } from "./composerAddMenu.logic";

const skill = (
  name: string,
  overrides: Partial<ServerProviderSkill> = {},
): ServerProviderSkill => ({ name, path: `/skills/${name}`, enabled: true, ...overrides });

describe("composer add skills", () => {
  it("lists invocable skills by their dollar name", () => {
    const items = composerAddSkillItems({
      provider: ProviderDriverKind.make("codex"),
      skills: [skill("commit-and-push")],
    });
    expect(items.map((item) => item.label)).toEqual(["Commit and Push"]);
  });

  it("omits disabled and agent-only skills while retaining user-only skills", () => {
    const items = composerAddSkillItems({
      provider: ProviderDriverKind.make("claudeAgent"),
      skills: [
        skill("disabled", { enabled: false }),
        skill("agent-only", { userInvocable: false }),
        skill("user-only", { userInvocationOnly: true }),
      ],
    });
    expect(items.map((item) => item.label)).toEqual(["User Only"]);
  });
});

describe("Goal message intent", () => {
  it("passes ordinary Build messages through unchanged", () => {
    expect(applyComposerGoalIntent("/review staged changes", false)).toBe("/review staged changes");
  });
  it("asks for measurable outcomes without displacing a provider command or skill", () => {
    const text = "/review $security-audit check the checkout flow";
    const message = applyComposerGoalIntent(text, true);
    expect(message.startsWith(`${text}\n\n`)).toBe(true);
    expect(message).toContain("Define measurable outcomes");
    expect(message).toContain("what remains");
  });
});
