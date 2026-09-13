import { describe, expect, it } from "vite-plus/test";
import { markdownImageUrlTransform, resolveMarkdownImageSource } from "./markdown-images";

describe("Markdown image destinations", () => {
  it.each([
    [
      "/Users/coreybaines/GitHub/pathway/.pathway/evidence/thread-environment-right.jpg",
      "/Users/coreybaines/GitHub/pathway/.pathway/evidence/thread-environment-right.jpg",
    ],
    ["./screens/你好%20world.png", "./screens/你好 world.png"],
    ["screens/a%23b%3Fc%25.png", "screens/a#b?c%.png"],
    ["screens/100%2520.png", "screens/100%20.png"],
    ["<screens/hello world.png>", "screens/hello world.png"],
    ["file:///Users/me/a%20b.png", "/Users/me/a b.png"],
    ["file:///C:/work/a%20b.png", "C:/work/a b.png"],
    ["file://server/share/a.png", "//server/share/a.png"],
    ["C:\\work\\a.png", "C:\\work\\a.png"],
    ["\\\\server\\share\\a.png", "\\\\server\\share\\a.png"],
    ["../escape.png", "../escape.png"],
    ["a.png?cache=1#fragment", "a.png"],
  ])("keeps %s as an environment path", (source, path) => {
    expect(resolveMarkdownImageSource(source)).toEqual({ kind: "workspace", path });
  });

  it("leaves relative resolution to the owning server for projects, worktrees, and conversations", () => {
    for (const cwd of ["/project", "/worktree", "/conversations/id", "C:\\work"]) {
      expect(resolveMarkdownImageSource("./image.png", cwd)).toEqual({
        kind: "workspace",
        path: "./image.png",
      });
    }
  });

  it("distinguishes root-relative web images from filesystem references", () => {
    expect(resolveMarkdownImageSource("/images/logo.png")).toEqual({
      kind: "web",
      url: "/images/logo.png",
    });
    expect(resolveMarkdownImageSource("/custom/project/image.png", "/custom/project")).toEqual({
      kind: "workspace",
      path: "/custom/project/image.png",
    });
    expect(
      resolveMarkdownImageSource("/custom/project-other/image.png", "/custom/project").kind,
    ).toBe("web");
  });

  it.each(["https://images.example/你好.png?size=2", "//images.example/a.png"])(
    "preserves web URL %s",
    (url) => {
      expect(resolveMarkdownImageSource(url)).toEqual({ kind: "web", url });
    },
  );

  it.each([
    "sandbox:/mnt/data/a.png",
    "javascript:alert(1)",
    "data:image/png;base64,AA",
    "",
    "a%00.png",
    "a%zz.png",
  ])("makes unsupported destination %s unavailable", (value) => {
    expect(resolveMarkdownImageSource(value)).toEqual({ kind: "unavailable" });
  });

  it("keeps supported local protocols for the renderer while sanitizing executable URLs", () => {
    expect(markdownImageUrlTransform("file:///C:/work/a.png")).toBe("file:///C:/work/a.png");
    expect(markdownImageUrlTransform("C:\\work\\a.png")).toBe("C:\\work\\a.png");
    expect(markdownImageUrlTransform("javascript:alert(1)")).toBe("");
  });
});
