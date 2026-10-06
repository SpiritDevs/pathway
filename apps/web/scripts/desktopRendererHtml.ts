import type { Plugin } from "vite-plus";

interface RendererAsset {
  readonly type: string;
  readonly fileName: string;
  readonly facadeModuleId?: string | null;
  readonly imports?: ReadonlyArray<string>;
}

export function desktopRendererHtml(
  html: string,
  bundle: Record<string, RendererAsset>,
  base: string,
): string {
  const provider = Object.values(bundle).find(
    (asset) =>
      asset.type === "chunk" &&
      asset.facadeModuleId
        ?.replaceAll("\\", "/")
        .endsWith("/components/clerk/ElectronClerkProvider.tsx"),
  );
  if (!provider) return html;
  const files = new Set<string>();
  const visit = (fileName: string) => {
    if (files.has(fileName)) return;
    files.add(fileName);
    for (const imported of bundle[fileName]?.imports ?? []) visit(imported);
  };
  visit(provider.fileName);
  const links = [...files]
    .map((fileName) => {
      const href = `${base}${fileName}`;
      return html.includes(`href="${href}"`)
        ? ""
        : `<link rel="modulepreload" crossorigin href="${href}">`;
    })
    .filter(Boolean)
    .join("\n");
  return html.replace("</head>", `${links}\n</head>`);
}

/** Emit a desktop entry alongside the shared web entry, using Vite's hashed chunk names. */
export function desktopRendererHtmlPlugin(): Plugin {
  let base = "/";
  return {
    name: "pathway:desktop-renderer-html",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      base = config.base;
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const index = bundle["index.html"];
        if (index?.type !== "asset") return;
        const html =
          typeof index.source === "string" ? index.source : new TextDecoder().decode(index.source);
        this.emitFile({
          type: "asset",
          fileName: "desktop.html",
          source: desktopRendererHtml(html, bundle, base),
        });
      },
    },
  };
}
