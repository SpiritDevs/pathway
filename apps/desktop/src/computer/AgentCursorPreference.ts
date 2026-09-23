/**
 * The agent cursor colors mirrored from the renderer, persisted so the Cua
 * driver host can push them at every session open. The pure parse/normalize
 * helpers are the boundary the renderer payload crosses; the caller supplies
 * the file path.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { fromJsonStringPretty } from "@spiritdevs/shared/schemaJson";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import type { CuaCursorStyle } from "./CuaDriverHost.ts";

/** A `#rrggbb` channel for the driver's `set_agent_cursor_style`. */
export type AgentCursorStylePreference = CuaCursorStyle;

export interface PersistedAgentCursorPreference {
  readonly version: 1;
  readonly style: AgentCursorStylePreference | null;
}

const AGENT_CURSOR_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

function normalizeChannel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim().toLowerCase();
  return AGENT_CURSOR_COLOR_PATTERN.test(candidate) ? candidate : undefined;
}

/**
 * The preference's normalized form: only usable lowercase `#rrggbb` channels
 * survive, and a style with no usable channel collapses to null (stock), so
 * nothing half-typed or malformed ever reaches the driver.
 */
export function normalizeAgentCursorStylePreference(
  value: unknown,
): AgentCursorStylePreference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const fill = normalizeChannel(candidate.fill);
  const rim = normalizeChannel(candidate.rim);
  const shadow = normalizeChannel(candidate.shadow);
  if (!fill && !rim && !shadow) return null;
  return {
    ...(fill ? { fill } : {}),
    ...(rim ? { rim } : {}),
    ...(shadow ? { shadow } : {}),
  };
}

export function parseAgentCursorPreference(value: unknown): PersistedAgentCursorPreference | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || !("style" in candidate)) return null;
  return { version: 1, style: normalizeAgentCursorStylePreference(candidate.style) };
}

/** Where the agent cursor colors mirrored from the renderer persist between sessions. */
export const agentCursorPreferencePath = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const path = yield* Path.Path;
  return path.join(environment.stateDir, "agent-cursor-colors.json");
});

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown));

/** The stored style, or null for stock (missing, empty, or unreadable file). Never fails. */
export const readAgentCursorPreference = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const text = yield* fileSystem.readFileString(filePath);
    return parseAgentCursorPreference(Option.getOrNull(decodeJson(text)))?.style ?? null;
  }).pipe(Effect.orElseSucceed(() => null));

/**
 * Persists the preference. Stock (null) removes the file, so "no overrides
 * stored" is literal: the default install never leaves a colors file behind.
 */
export const writeAgentCursorPreference = Effect.fn("writeAgentCursorPreference")(function* (
  filePath: string,
  style: AgentCursorStylePreference | null | undefined,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const normalized = normalizeAgentCursorStylePreference(style);
  if (!normalized) {
    yield* fileSystem.remove(filePath, { force: true });
    return;
  }
  const payload: PersistedAgentCursorPreference = { version: 1, style: normalized };
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  const encoded = yield* encodeJson(payload);
  yield* fileSystem.writeFileString(filePath, `${encoded}\n`);
});
