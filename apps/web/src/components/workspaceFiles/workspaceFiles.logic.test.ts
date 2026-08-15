import type { ProjectEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  fileManagerBreadcrumbs,
  formatFileSize,
  listFileManagerItems,
  parentDirectory,
} from "./workspaceFiles.logic";

const entries: ProjectEntry[] = [
  { path: "README.md", kind: "file" },
  { path: "apps", kind: "directory" },
  { path: "apps/web/src/main.tsx", kind: "file" },
  { path: "apps/server/index.ts", kind: "file" },
];

describe("listFileManagerItems", () => {
  it("lists immediate children and synthesizes nested folders", () => {
    expect(listFileManagerItems(entries, "", "")).toEqual([
      { path: "apps", name: "apps", kind: "directory" },
      { path: "README.md", name: "README.md", kind: "file" },
    ]);
    expect(listFileManagerItems(entries, "apps", "")).toEqual([
      { path: "apps/server", name: "server", kind: "directory" },
      { path: "apps/web", name: "web", kind: "directory" },
    ]);
  });

  it("searches the full path from any directory", () => {
    expect(listFileManagerItems(entries, "apps", "main")).toEqual([
      { path: "apps/web/src/main.tsx", name: "main.tsx", kind: "file" },
    ]);
  });
});

describe("file manager helpers", () => {
  it("builds breadcrumbs and parent paths", () => {
    expect(fileManagerBreadcrumbs("apps/web")).toEqual([
      { label: "Files", path: "" },
      { label: "apps", path: "apps" },
      { label: "web", path: "apps/web" },
    ]);
    expect(parentDirectory("apps/web")).toBe("apps");
  });

  it("formats byte counts", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1_536)).toBe("1.5 KB");
    expect(formatFileSize(2_097_152)).toBe("2.0 MB");
  });
});
