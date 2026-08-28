import { describe, expect, it } from "vite-plus/test";

import {
  canPreloadBrowsePath,
  completeFilesystemBrowsePath,
  createBrowseNavigationCoordinator,
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "./filesystem.ts";

describe("filesystem browse model", () => {
  it("derives the browse target and navigation state", () => {
    expect(getFilesystemBrowsePath("~/projects/pathway")).toEqual({
      isBrowsing: true,
      directoryPath: "~/projects/",
      filterQuery: "pathway",
      parentPath: "~/",
      canBrowseUp: true,
    });
    expect(getFilesystemBrowsePath("C:\\Users\\test", "MacIntel").isBrowsing).toBe(false);
    expect(getFilesystemBrowsePath("~/projects/", "", false).isBrowsing).toBe(false);
  });

  it("filters names, hidden directories, and exact matches consistently", () => {
    const entries = [
      { name: ".config", fullPath: "/Users/test/.config" },
      { name: "Code", fullPath: "/Users/test/Code" },
      { name: "codething", fullPath: "/Users/test/codething" },
    ];

    expect(filterFilesystemBrowseEntries(entries, "co")).toEqual({
      visibleEntries: entries.slice(1, 3),
      exactEntry: null,
    });
    expect(filterFilesystemBrowseEntries(entries, "").visibleEntries).toEqual(entries.slice(1));
    expect(filterFilesystemBrowseEntries(entries, ".").visibleEntries).toEqual(entries.slice(0, 1));
    expect(filterFilesystemBrowseEntries(entries, "Code").exactEntry).toEqual(entries[1]);
  });

  it("completes a sole directory match and keeps the platform separator", () => {
    const entries = [
      { name: "GitHub", fullPath: "/Users/test/GitHub" },
      { name: "Pictures", fullPath: "/Users/test/Pictures" },
    ];

    expect(completeFilesystemBrowsePath("~/git", entries)).toBe("~/GitHub/");
    expect(completeFilesystemBrowsePath("C:\\Users\\git", entries)).toBe("C:\\Users\\GitHub\\");
  });

  it("completes multiple matches only through their shared prefix", () => {
    const entries = [
      { name: "GitHub", fullPath: "/Users/test/GitHub" },
      { name: "GitLab", fullPath: "/Users/test/GitLab" },
      { name: "Pictures", fullPath: "/Users/test/Pictures" },
    ];

    expect(completeFilesystemBrowsePath("~/gi", entries)).toBe("~/Git");
    expect(completeFilesystemBrowsePath("~/Git", entries)).toBeNull();
  });

  it("does not complete when no visible directory matches", () => {
    const entries = [{ name: ".git", fullPath: "/Users/test/.git" }];

    expect(completeFilesystemBrowsePath("~/gi", entries)).toBeNull();
    expect(completeFilesystemBrowsePath("~/.", entries)).toBe("~/.git/");
  });
});

describe("browse navigation", () => {
  it("only commits the latest valid navigation", async () => {
    const navigation = createBrowseNavigationCoordinator();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const commits: string[] = [];
    const commit = (name: string) => () => commits.push(name);
    const firstRun = navigation.run(() => first.promise, commit("first"));
    const secondRun = navigation.run(() => second.promise, commit("second"));

    second.resolve();
    await expect(secondRun).resolves.toBe(true);
    first.resolve();
    await expect(firstRun).resolves.toBe(false);

    const invalidated = Promise.withResolvers<void>();
    const invalidatedRun = navigation.run(() => invalidated.promise, commit("stale"));
    navigation.invalidate();
    invalidated.resolve();

    await expect(invalidatedRun).resolves.toBe(false);
    expect(commits).toEqual(["second"]);
  });

  it("only preloads connected environments", () => {
    expect(canPreloadBrowsePath("connected")).toBe(true);
    expect(canPreloadBrowsePath("offline")).toBe(false);
    expect(canPreloadBrowsePath("reconnecting")).toBe(false);
    expect(canPreloadBrowsePath(null)).toBe(false);
  });
});
