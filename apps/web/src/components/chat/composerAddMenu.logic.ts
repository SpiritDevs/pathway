import type { ProviderDriverKind, ServerProviderSkill } from "@spiritdevs/contracts";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { formatProviderSkillDisplayName } from "../../providerSkillPresentation";
import { searchProviderSkills } from "../../providerSkillSearch";

export const GOAL_COMPOSER_PLACEHOLDER =
  "Describe your goal, define measurable outcomes for best results.";

export type ComposerAddSkillItem = Extract<ComposerCommandItem, { type: "skill" }>;

export function composerAddSkillItems(input: {
  provider: ProviderDriverKind;
  skills: readonly ServerProviderSkill[];
}): ComposerAddSkillItem[] {
  return searchProviderSkills(input.skills, "").map((skill) => ({
    id: `skill:${input.provider}:${skill.name}`,
    type: "skill" as const,
    provider: input.provider,
    skill,
    label: formatProviderSkillDisplayName(skill),
    description: skill.shortDescription ?? skill.description ?? "",
  }));
}

/** Keep commands at the start so providers can still expand them. */
export function applyComposerGoalIntent(text: string, goalMode: boolean): string {
  return goalMode
    ? `${text}\n\nTreat this request as a goal. Define measurable outcomes, work toward them, and report which outcomes are complete and what remains.`
    : text;
}
