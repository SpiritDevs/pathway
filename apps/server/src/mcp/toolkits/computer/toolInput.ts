/**
 * Readers for raw MCP tool arguments. Each fails with `ToolInputError`, whose
 * message the agent reads verbatim, instead of throwing.
 *
 * @module mcp/toolkits/computer/toolInput
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ToolInputError extends Schema.TaggedErrorClass<ToolInputError>()("ToolInputError", {
  message: Schema.String,
}) {}

const invalid = (message: string) => Effect.fail(new ToolInputError({ message }));

export const errorText = (error: unknown): string =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof error.message === "string"
    ? error.message
    : String(error);

export function readStringArg(
  args: Record<string, unknown>,
  name: string,
  options?: { readonly required?: false },
): Effect.Effect<string | undefined, ToolInputError>;
export function readStringArg(
  args: Record<string, unknown>,
  name: string,
  options: { readonly required: true },
): Effect.Effect<string, ToolInputError>;
export function readStringArg(
  args: Record<string, unknown>,
  name: string,
  options?: { readonly required?: boolean },
): Effect.Effect<string | undefined, ToolInputError> {
  const value = args[name];
  if (value === undefined || value === null) {
    return options?.required
      ? invalid(`Missing required argument "${name}".`)
      : Effect.succeed(undefined);
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalid(`Argument "${name}" must be a non-empty string.`);
  }
  return Effect.succeed(value.trim());
}

/**
 * A string argument taken exactly as written, with no trimming.
 *
 * `readStringArg` trims, which is right for an identifier and wrong for an
 * accessibility label: the desktop targeters match labels verbatim on purpose,
 * so trimming here would retarget a caller that named `"Save "` at a different
 * control called `"Save"`.
 *
 * Still refuses a blank string: a label made only of spaces names nothing, and
 * passing it on would match everything in scope.
 */
export function readVerbatimStringArg(
  args: Record<string, unknown>,
  name: string,
): Effect.Effect<string | undefined, ToolInputError> {
  const value = args[name];
  if (value === undefined || value === null) return Effect.succeed(undefined);
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalid(`Argument "${name}" must be a non-empty string.`);
  }
  return Effect.succeed(value);
}

export function readNumberArg(
  args: Record<string, unknown>,
  name: string,
): Effect.Effect<number | undefined, ToolInputError> {
  const value = args[name];
  if (value === undefined || value === null) return Effect.succeed(undefined);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return invalid(`Argument "${name}" must be a number.`);
  }
  return Effect.succeed(value);
}

export function readBooleanArg(
  args: Record<string, unknown>,
  name: string,
): Effect.Effect<boolean | undefined, ToolInputError> {
  const value = args[name];
  if (value === undefined || value === null) return Effect.succeed(undefined);
  if (typeof value !== "boolean") {
    return invalid(`Argument "${name}" must be a boolean.`);
  }
  return Effect.succeed(value);
}

export function readRecordArg(
  args: Record<string, unknown>,
  name: string,
): Effect.Effect<Record<string, unknown> | undefined, ToolInputError> {
  const value = args[name];
  if (value === undefined || value === null) return Effect.succeed(undefined);
  if (typeof value !== "object" || Array.isArray(value)) {
    return invalid(`Argument "${name}" must be an object.`);
  }
  return Effect.succeed(value as Record<string, unknown>);
}

export function readStringArrayArg(
  args: Record<string, unknown>,
  name: string,
): Effect.Effect<ReadonlyArray<string> | undefined, ToolInputError> {
  const value = args[name];
  if (value === undefined || value === null) return Effect.succeed(undefined);
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
  ) {
    return invalid(`Argument "${name}" must be an array of non-empty strings.`);
  }
  return Effect.succeed(value.map((entry: string) => entry.trim()));
}
