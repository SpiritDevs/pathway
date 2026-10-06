// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vite-plus/test";
import { desktopRendererHtml, desktopRendererHtmlPlugin } from "../scripts/desktopRendererHtml";

describe("desktop renderer preloads", () => {
  it("preloads the hashed Electron Clerk chunk and static imports in the desktop entry", () => {
    const web = '<head><link rel="modulepreload" crossorigin href="/assets/vendor-123.js"></head>';
    const html = desktopRendererHtml(
      web,
      {
        "assets/clerk-456.js": {
          type: "chunk",
          fileName: "assets/clerk-456.js",
          facadeModuleId: "/src/components/clerk/ElectronClerkProvider.tsx",
          imports: ["assets/vendor-123.js", "assets/native-789.js"],
        },
        "assets/native-789.js": {
          type: "chunk",
          fileName: "assets/native-789.js",
          imports: ["assets/vendor-123.js"],
        },
        "assets/vendor-123.js": { type: "chunk", fileName: "assets/vendor-123.js", imports: [] },
      },
      "/",
    );
    expect(html).toContain('rel="modulepreload" crossorigin href="/assets/clerk-456.js"');
    expect(html).toContain('rel="modulepreload" crossorigin href="/assets/native-789.js"');
    expect(html.match(/vendor-123/g)).toHaveLength(1);
    expect(web).not.toContain("clerk-456");
  });
  it("emits a separate desktop entry after Vite generates hashed lazy chunks", async () => {
    const directory = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-renderer-html-")),
    );
    try {
      await NodeFSP.mkdir(NodePath.join(directory, "components/clerk"), { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(directory, "index.html"),
        '<head></head><body><script type="module" src="/main.js"></script></body>',
      );
      await NodeFSP.writeFile(
        NodePath.join(directory, "main.js"),
        'window.loadClerk = () => import("./components/clerk/ElectronClerkProvider.tsx");',
      );
      await NodeFSP.writeFile(
        NodePath.join(directory, "components/clerk/ElectronClerkProvider.tsx"),
        'export default "clerk";',
      );
      const result = await build({
        configFile: false,
        root: directory,
        base: "/desktop/",
        plugins: [desktopRendererHtmlPlugin()],
        logLevel: "silent",
        build: { write: false, minify: false },
      });
      if (Array.isArray(result) || !("output" in result))
        throw new Error("Expected a single build output");
      const desktop = result.output.find(
        (asset) => asset.type === "asset" && asset.fileName === "desktop.html",
      );
      const hosted = result.output.find(
        (asset) => asset.type === "asset" && asset.fileName === "index.html",
      );
      const clerk = result.output.find(
        (asset) =>
          asset.type === "chunk" && asset.facadeModuleId?.endsWith("ElectronClerkProvider.tsx"),
      );
      if (desktop?.type !== "asset" || hosted?.type !== "asset" || clerk?.type !== "chunk")
        throw new Error("Missing renderer entries or Clerk chunk");
      expect(desktop.source).toContain(
        `rel="modulepreload" crossorigin href="/desktop/${clerk.fileName}"`,
      );
      expect(hosted.source).not.toContain(`href="/desktop/${clerk.fileName}"`);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps builds without an Electron chunk usable", () => {
    expect(desktopRendererHtml("<head></head>", {}, "/")).toBe("<head></head>");
  });
});
