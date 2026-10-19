// @effect-diagnostics nodeBuiltinImport:off - Tests use isolated temporary filesystem fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { measureStorageDirectory } from "./StorageService.ts";

describe("bounded storage accounting", () => {
  it("counts hard links once and never follows a symlink outside the worktree", async () => {
    const fixture = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "pathway-storage-accounting-"),
    );
    try {
      const tree = NodePath.join(fixture, "tree");
      await NodeFSP.mkdir(tree);
      await NodeFSP.writeFile(NodePath.join(tree, "file"), "x".repeat(8192));
      await NodeFSP.link(NodePath.join(tree, "file"), NodePath.join(tree, "hardlink"));
      await NodeFSP.writeFile(NodePath.join(fixture, "outside"), "x".repeat(65536));
      await NodeFSP.symlink(NodePath.join(fixture, "outside"), NodePath.join(tree, "symlink"));
      const [directory, file, symlink] = await Promise.all([
        NodeFSP.lstat(tree),
        NodeFSP.lstat(NodePath.join(tree, "file")),
        NodeFSP.lstat(NodePath.join(tree, "symlink")),
      ]);
      expect(await measureStorageDirectory(tree)).toBe(
        (directory.blocks + file.blocks + symlink.blocks) * 512,
      );
      expect(await measureStorageDirectory(tree, 1)).toBeNull();
    } finally {
      await NodeFSP.rm(fixture, { recursive: true, force: true });
    }
  });
  it("reports unknown for absent directories rather than zero bytes", async () => {
    expect(await measureStorageDirectory("/nonexistent-pathway-storage-fixture")).toBeNull();
  });
});

describe("Git reclamation safety", () => {
  it("protects roots, unique work and unpublished commits while reclaiming ignored files and preserving the branch", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execute = promisify(execFile);
    const { inspectStorageGitWorktree, removeStorageGitWorktree } =
      await import("./StorageService.ts");
    const fixture = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-storage-git-"));
    const root = NodePath.join(fixture, "main");
    const tree = NodePath.join(fixture, "worktree");
    const git = (cwd: string, args: string[]) => execute("git", ["-C", cwd, ...args]);
    try {
      await NodeFSP.mkdir(root);
      await git(root, ["init", "-b", "main"]);
      await git(root, ["config", "user.name", "Storage fixture"]);
      await git(root, ["config", "user.email", "storage@example.invalid"]);
      await NodeFSP.writeFile(NodePath.join(root, ".gitignore"), "generated/\n");
      await git(root, ["add", ".gitignore"]);
      await git(root, ["commit", "-m", "fixture"]);
      await git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
      await git(root, ["worktree", "add", "-b", "topic", tree]);
      expect(await inspectStorageGitWorktree(root, root, "main")).toContain(
        "Not an unlocked linked worktree",
      );
      await NodeFSP.mkdir(NodePath.join(tree, "generated"));
      await NodeFSP.writeFile(NodePath.join(tree, "generated", "cache"), "ignored cache");
      expect(await inspectStorageGitWorktree(tree, root, "topic")).toEqual([]);
      await NodeFSP.writeFile(NodePath.join(tree, "valuable"), "unique work");
      expect(await inspectStorageGitWorktree(tree, root, "topic")).toContain(
        "Uncommitted or untracked files",
      );
      await expect(removeStorageGitWorktree(tree, root, "topic")).rejects.toThrow();
      await git(tree, ["add", "valuable"]);
      await git(tree, ["commit", "-m", "unique work"]);
      expect(await inspectStorageGitWorktree(tree, root, "topic")).toContain("Unpublished commits");
      await git(tree, ["update-ref", "refs/remotes/origin/topic", "HEAD"]);
      const tip = (await git(tree, ["rev-parse", "HEAD"])).stdout.trim();
      await removeStorageGitWorktree(tree, root, "topic");
      await expect(NodeFSP.stat(tree)).rejects.toThrow();
      expect((await git(root, ["rev-parse", "topic"])).stdout.trim()).toBe(tip);
      await git(root, ["worktree", "add", "--", tree, "topic"]);
      expect(await NodeFSP.readFile(NodePath.join(tree, "valuable"), "utf8")).toBe("unique work");
      await expect(NodeFSP.stat(NodePath.join(tree, "generated"))).rejects.toThrow();
      await git(tree, ["checkout", "--detach"]);
      await NodeFSP.writeFile(NodePath.join(tree, "valuable"), "modified work");
      await NodeFSP.writeFile(NodePath.join(tree, "untracked"), "untracked work");
      await expect(removeStorageGitWorktree(tree, root, null)).rejects.toThrow();
      await git(root, ["worktree", "lock", tree]);
      await expect(removeStorageGitWorktree(tree, root, null, true)).rejects.toThrow();
      await git(root, ["worktree", "unlock", tree]);
      await expect(removeStorageGitWorktree(root, root, "main", true)).rejects.toThrow();
      await removeStorageGitWorktree(tree, root, null, true);
      await expect(NodeFSP.stat(tree)).rejects.toThrow();
      expect((await git(root, ["rev-parse", "topic"])).stdout.trim()).toBe(tip);
    } finally {
      await NodeFSP.rm(fixture, { recursive: true, force: true });
    }
  });
});

describe("storage state recovery", () => {
  it("keeps corrupt policy bytes and starts with cleanup disabled", async () => {
    const { readStorageState } = await import("./StorageService.ts");
    const fixture = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-storage-state-"));
    const file = NodePath.join(fixture, "storage-management.json");
    try {
      await NodeFSP.writeFile(file, "{ broken policy");
      const loaded = await readStorageState(file);
      expect(loaded.state.policy.enabled).toBe(false);
      expect(loaded.error).toMatch(/could not be read/);
      expect(await NodeFSP.readFile(file, "utf8")).toBe("{ broken policy");
      const missing = await readStorageState(NodePath.join(fixture, "missing.json"));
      expect(missing.error).toBeNull();
      expect(missing.state.policy.enabled).toBe(false);
    } finally {
      await NodeFSP.rm(fixture, { recursive: true, force: true });
    }
  });
});
