import { TextGenerationError } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const isTextGenerationError = Schema.is(TextGenerationError);

/** Convert an Effect Schema to a flat JSON Schema object, inlining `$defs` when present. */
export function toJsonSchemaObject(schema: Schema.Top): unknown {
  const document = Schema.toJsonSchemaDocument(schema);
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return { ...document.schema, $defs: document.definitions };
  }
  return document.schema;
}

/**
 * How long an investigation may run before it is killed.
 *
 * Fifteen minutes, against the three the other operations get. Those summarise text that is
 * already in hand; this one reads a repository, and a real answer on a large tree routinely takes
 * longer than a naming task ever will. The cap exists so a wedged CLI cannot hold the single
 * enrichment slot forever, not to bound the model's thinking.
 */
export const INVESTIGATION_TIMEOUT_MS = 900_000;

/** Truncate a text section to `maxChars`, appending a `[truncated]` marker when needed. */
export function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars);
  return `${truncated}\n\n[truncated]`;
}

/** Normalise a raw commit subject to imperative-mood, ≤72 chars, no trailing period. */
export function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  return withoutTrailingPeriod.slice(0, 72).trimEnd();
}

/** Normalise a raw PR title to a single line with a sensible fallback. */
export function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  if (singleLine.length > 0) {
    return singleLine;
  }
  return "Update project changes";
}

/** Normalise a raw thread title to a compact single-line sidebar-safe label. */
export function sanitizeThreadTitle(raw: string): string {
  const normalized = raw
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized || normalized.trim().length === 0) {
    return "New thread";
  }

  if (normalized.length <= 50) {
    return normalized;
  }

  return `${normalized.slice(0, 47).trimEnd()}...`;
}

/** CLI name to human-readable label, e.g. "codex" → "Codex CLI (`codex`)" */
function cliLabel(cliName: string): string {
  const capitalized = cliName.charAt(0).toUpperCase() + cliName.slice(1);
  return `${capitalized} CLI (\`${cliName}\`)`;
}

/**
 * Normalize an unknown error from a CLI text generation process into a
 * typed `TextGenerationError`. Parameterized by CLI name so both Codex
 * and Claude (and future providers) can share the same logic.
 */
export function normalizeCliError(
  cliName: string,
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (isTextGenerationError(error)) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes(`Command not found: ${cliName}`) ||
      lower.includes(`spawn ${cliName}`) ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: `${cliLabel(cliName)} is required but not available on PATH.`,
        cause: error,
      });
    }
    return new TextGenerationError({
      operation,
      detail: fallback,
      cause: error,
    });
  }

  return new TextGenerationError({
    operation,
    detail: fallback,
    cause: error,
  });
}

const CLI_ERROR_MAX_BYTES = 16 * 1024;
const CLI_ERROR_TRUNCATION_MARKER = "[truncated earlier output]\n";

/** Retains the diagnostic tail without splitting a UTF-8 character. */
export function cliErrorOutputTail(output: string): string {
  const bytes = Buffer.from(output);
  if (bytes.length <= CLI_ERROR_MAX_BYTES) return output;
  let start = bytes.length - CLI_ERROR_MAX_BYTES + CLI_ERROR_TRUNCATION_MARKER.length;
  while ((bytes[start]! & 0xc0) === 0x80) start += 1;
  return CLI_ERROR_TRUNCATION_MARKER + bytes.subarray(start).toString("utf8");
}

/** Drains stderr while retaining only its tail, including across stream chunks. */
export const readCliStderr = <E>(
  cliName: string,
  operation: string,
  stream: Stream.Stream<Uint8Array, E>,
) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => ({ output: "", truncated: false }),
      (state, chunk) => {
        const combined = state.output + chunk;
        const output = cliErrorOutputTail(combined);
        const truncated = output !== combined;
        return {
          output: truncated ? output.slice(CLI_ERROR_TRUNCATION_MARKER.length) : output,
          truncated: state.truncated || truncated,
        };
      },
    ),
    Effect.map(({ output, truncated }) =>
      truncated ? cliErrorOutputTail(CLI_ERROR_TRUNCATION_MARKER + output) : output,
    ),
    Effect.mapError((cause) =>
      normalizeCliError(cliName, operation, cause, "Failed to collect process output"),
    ),
  );

/** Only explicit provider credential failures are terminal; quota and transport errors may recover. */
export function isTextGenerationAuthenticationError(error: unknown): boolean {
  if (!isTextGenerationError(error)) return false;
  const authenticationFailure =
    /\brefresh_token_reused\b|refresh token (?:was|has) already (?:been )?used|\b401\s+unauthori[sz]ed\b|\b(?:http(?: error)?|status(?: code)?)["':=\s]+401\b/i;
  if (authenticationFailure.test(error.detail)) return true;
  let cause = error.cause;
  for (let depth = 0; depth < 4 && Predicate.isObject(cause); depth += 1) {
    if (cause.status === 401 || cause.statusCode === 401 || cause.code === "refresh_token_reused")
      return true;
    if (Predicate.isObject(cause.response) && cause.response.status === 401) return true;
    if (typeof cause.message === "string" && authenticationFailure.test(cause.message)) return true;
    cause = cause.cause;
  }
  return false;
}
