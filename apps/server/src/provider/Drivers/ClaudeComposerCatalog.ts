import type { ClaudeSettings, ServerProviderComposerCatalog } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import { discoverClaudeSkills } from "./ClaudeSkills.ts";

/** Replace the startup workspace's skills with those the selected workspace can run. */
export const loadClaudeComposerCatalog = Effect.fn("loadClaudeComposerCatalog")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd: string | null,
  environment: NodeJS.ProcessEnv,
  snapshot: ServerProviderComposerCatalog,
) {
  const skills = yield* discoverClaudeSkills(config, cwd ?? undefined, environment);
  const skillNames = new Set([...snapshot.skills, ...skills].map((skill) => skill.name));
  const slashCommands = snapshot.slashCommands.filter(
    (command) => command.name === "compact" || !skillNames.has(command.name),
  );
  const commandNames = new Set(slashCommands.map((command) => command.name));
  for (const skill of skills) {
    if (!skill.enabled || skill.userInvocable === false || commandNames.has(skill.name)) continue;
    slashCommands.push({
      name: skill.name,
      ...(skill.description ? { description: skill.description } : {}),
    });
  }
  return { skills, slashCommands };
});
