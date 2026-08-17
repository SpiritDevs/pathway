import type { APIRoute } from "astro";

import { buildPathwayProjectFileJsonSchema } from "@spiritdevs/shared/pathwayProjectFile";

// Rendered at build time; published at https://pathway.codes/schema/pathway.json so
// pathway.json files can reference it via "$schema" for editor/LSP support.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildPathwayProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
