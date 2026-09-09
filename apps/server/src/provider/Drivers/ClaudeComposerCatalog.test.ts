import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { loadClaudeComposerCatalog } from "./ClaudeComposerCatalog.ts";
import { discoverClaudeSkills } from "./ClaudeSkills.ts";
import { planClaudeSkillDispatch } from "./ClaudeSkillDispatch.ts";

it.layer(NodeServices.layer)("Claude composer catalog", (it) => {
  it.effect("uses the target project's skill metadata and drops startup-only slash entries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-claude-catalog-" });
      const config = { homePath: path.join(root, "home") };
      const projectA = path.join(root, "a");
      const projectB = path.join(root, "b");
      for (const [cwd, name, description] of [
        [projectA, "deploy", "Deploy project A"],
        [projectA, "only-a", "Only in A"],
        [projectB, "deploy", "Deploy project B"],
      ]) {
        const directory = path.join(cwd!, ".claude", "skills", name!);
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(
          path.join(directory, "SKILL.md"),
          `---\ndescription: ${description}\n---\nInstructions`,
        );
      }
      const startup = {
        skills: yield* discoverClaudeSkills(config, projectA, {}),
        slashCommands: [
          { name: "compact" },
          { name: "deploy", description: "Deploy project A" },
          { name: "only-a" },
        ],
      };
      const catalog = yield* loadClaudeComposerCatalog(config, projectB, {}, startup);
      assert.deepEqual(
        catalog.skills.map((skill) => [skill.name, skill.description, skill.path]),
        [
          [
            "deploy",
            "Deploy project B",
            path.join(projectB, ".claude", "skills", "deploy", "SKILL.md"),
          ],
        ],
      );
      assert.deepEqual(catalog.slashCommands, [
        { name: "compact" },
        { name: "deploy", description: "Deploy project B" },
      ]);
      const dispatchedSkills = yield* discoverClaudeSkills(config, projectB, {});
      assert.deepEqual(catalog.skills, dispatchedSkills);
      assert.equal(
        planClaudeSkillDispatch(
          "please $deploy",
          new Set(dispatchedSkills.map((skill) => skill.name)),
        )?.skillName,
        "deploy",
      );
      const emptyProject = yield* loadClaudeComposerCatalog(
        config,
        path.join(root, "empty"),
        {},
        startup,
      );
      assert.deepEqual(emptyProject, { skills: [], slashCommands: [{ name: "compact" }] });
    }),
  );

  it.effect("applies target-project overrides while preserving native compact", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-claude-catalog-" });
      const config = { homePath: path.join(root, "home") };
      const cwd = path.join(root, "project");
      for (const name of ["deploy", "compact"]) {
        const directory = path.join(config.homePath, "skills", name);
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(
          path.join(directory, "SKILL.md"),
          "---\ndescription: User skill\n---\nInstructions",
        );
      }
      yield* fs.makeDirectory(path.join(cwd, ".claude"), { recursive: true });
      yield* fs.writeFileString(
        path.join(cwd, ".claude", "settings.json"),
        '{"skillOverrides":{"deploy":"off","compact":"off"}}',
      );
      const catalog = yield* loadClaudeComposerCatalog(
        config,
        cwd,
        {},
        {
          skills: [],
          slashCommands: [{ name: "compact", description: "Native compact" }, { name: "deploy" }],
        },
      );
      assert.deepEqual(
        catalog.skills.map((skill) => skill.enabled),
        [false, false],
      );
      assert.deepEqual(catalog.slashCommands, [{ name: "compact", description: "Native compact" }]);
    }),
  );
});
