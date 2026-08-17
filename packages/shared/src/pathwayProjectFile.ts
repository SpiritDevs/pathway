import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { PathwayProjectFile, Pathway_PROJECT_FILE_SCHEMA_URL } from "@spiritdevs/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `pathway.json` file contents (lenient JSONC string) and the
 * decoded {@link PathwayProjectFile}.
 */
export const PathwayProjectFileFromJson = fromLenientJson(PathwayProjectFile);

const decodePathwayProjectFile = Schema.decodeExit(PathwayProjectFileFromJson);

/**
 * Decode raw `pathway.json` contents, treating invalid or malformed files as
 * absent. Clients use this to read optional defaults (scripts, thread env
 * mode) without surfacing decode errors to the user.
 */
export function parsePathwayProjectFile(contents: string): PathwayProjectFile | null {
  const decoded = decodePathwayProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

/**
 * Build the publishable JSON Schema document for `pathway.json` (draft 2020-12).
 *
 * Served from the marketing site at {@link Pathway_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildPathwayProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(PathwayProjectFile);
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: Pathway_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
