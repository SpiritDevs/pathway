interface MarkdownNode {
  type?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hProperties?: Record<string, unknown> };
}

export function parseVisualizationReference(text: string): { path: string; title: string } | null {
  const match = /^visualize(\{[\s\S]*\})$/.exec(text.trim());
  if (!match?.[1]) return null;
  try {
    const value: unknown = JSON.parse(match[1]);
    if (typeof value !== "object" || value === null || !("path" in value)) return null;
    const path = value.path;
    if (
      typeof path !== "string" ||
      path.length > 1024 ||
      [...path].some((character) => character.charCodeAt(0) < 32) ||
      !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path) ||
      !/\.html?$/i.test(path)
    )
      return null;
    const title = "title" in value && typeof value.title === "string" ? value.title.trim() : "";
    const filename = path.split(/[\\/]/).at(-1) ?? "Visualization";
    return { path, title: title || filename.replace(/\.html?$/i, "").replace(/[-_]+/g, " ") };
  } catch {
    return null;
  }
}

/** Read the original paragraph so Markdown cannot unescape JSON paths or interpret title markup. */
export function remarkVisualizations() {
  return (tree: MarkdownNode, file: { value: unknown }) => {
    const source = String(file.value);
    if (!source.includes("visualize")) return;
    const visit = (node: MarkdownNode) => {
      if (node.type === "paragraph") {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        const reference =
          start === undefined || end === undefined
            ? null
            : parseVisualizationReference(source.slice(start, end));
        if (reference) {
          node.children = [];
          node.data = {
            ...node.data,
            hProperties: {
              ...node.data?.hProperties,
              dataVisualizationPath: reference.path,
              dataVisualizationTitle: reference.title,
            },
          };
          return;
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
