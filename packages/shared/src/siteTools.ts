/**
 * WebMCP site tools in the desktop's built-in browser. Websites register tools
 * with `navigator.modelContext`; agents list and call them through page
 * evaluation. The desktop preload installs the API before page scripts run,
 * and only when Settings → Browser → Enable site tools is on.
 */

/** The page global the evaluate expressions below read. Not enumerable. */
const SITE_TOOLS_GLOBAL = "__pathwaySiteTools";

interface SiteTool {
  readonly name: string;
  readonly description?: unknown;
  readonly inputSchema?: unknown;
  readonly execute: (input: unknown, client: unknown) => unknown;
}

/** Installs `navigator.modelContext` in a page. Runs in the page's main world. */
export function installSiteToolsShim(scope: typeof globalThis): void {
  const navigator = scope.navigator as (Navigator & { modelContext?: unknown }) | undefined;
  if (!navigator || "modelContext" in navigator) return;
  const tools = new Map<string, SiteTool>();
  const register = (tool: SiteTool) => {
    if (typeof tool?.name !== "string" || tool.name === "" || typeof tool.execute !== "function") {
      throw new TypeError("A site tool needs a name and an execute function.");
    }
    tools.set(tool.name, tool);
    return {
      unregister: () => {
        if (tools.get(tool.name) === tool) tools.delete(tool.name);
      },
    };
  };
  const modelContext = Object.freeze({
    provideContext: (context?: { readonly tools?: ReadonlyArray<SiteTool> }) => {
      tools.clear();
      for (const tool of context?.tools ?? []) register(tool);
    },
    clearContext: () => tools.clear(),
    registerTool: register,
    unregisterTool: (name: string) => {
      tools.delete(name);
    },
  });
  Object.defineProperty(navigator, "modelContext", { value: modelContext, enumerable: true });
  Object.defineProperty(scope, SITE_TOOLS_GLOBAL, {
    value: Object.freeze({
      list: () =>
        [...tools.values()].map((tool) => ({
          name: tool.name,
          description: typeof tool.description === "string" ? tool.description : null,
          ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
        })),
      call: async (name: string, input: unknown) => {
        const tool = tools.get(name);
        if (!tool) throw new Error(`This page has no site tool named ${name}.`);
        // Agents run without a person at the page, so interaction requests run directly.
        return await tool.execute(input, {
          requestUserInteraction: async (callback: () => unknown) => await callback(),
        });
      },
    }),
  });
}

/** Evaluates to `{ available, tools }` for the page's registered site tools. */
export const SITE_TOOLS_LIST_EXPRESSION = `(() => { const siteTools = globalThis.${SITE_TOOLS_GLOBAL}; return siteTools ? { available: true, tools: siteTools.list() } : { available: false, tools: [] }; })()`;

/** Evaluates to a promise of one site tool's result. */
export const siteToolCallExpression = (name: string, input: unknown): string =>
  `globalThis.${SITE_TOOLS_GLOBAL}.call(${JSON.stringify(name)}, ${JSON.stringify(input ?? {})})`;
