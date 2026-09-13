import { describe, expect, it } from "vite-plus/test";
import { resolveMarkdownFileLinkMeta } from "~/markdown-links";
import { buildMarkdownImageGallery } from "./workspaceImageGallery.logic";

describe("markdown image galleries", () => {
  it("opens the clicked image among distinct image links from its message", () => {
    const links = [
      "/project/screens/light.png",
      "/project/notes.md",
      "/project/screens/dark.png",
      "/project/demo.MP4",
      "/project/screens/light.png:12",
      "/elsewhere/other.png",
      "/project/screens/animated.GIF",
    ].flatMap((href) => {
      const meta = resolveMarkdownFileLinkMeta(href, "/project");
      return meta ? [meta] : [];
    });
    expect(buildMarkdownImageGallery("screens/dark.png", links)).toEqual({
      paths: ["screens/light.png", "screens/dark.png", "demo.MP4", "screens/animated.GIF"],
      initialIndex: 1,
    });
  });

  it("includes a clicked link that was not in the precomputed metadata", () => {
    expect(buildMarkdownImageGallery("screens/new.webp", [])).toEqual({
      paths: ["screens/new.webp"],
      initialIndex: 0,
    });
  });
});
