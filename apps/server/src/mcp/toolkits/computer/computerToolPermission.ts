/**
 * Which provider tool calls are Pathway's own Computer tools, and when a
 * provider's permission prompt for one may be skipped because Pathway asks
 * the user itself (ADR 0048).
 *
 * @module mcp/toolkits/computer/computerToolPermission
 */
import type { ProviderInteractionMode, RuntimeMode } from "@spiritdevs/contracts";

/** Exact tool names owned by Pathway's capability-gated Computer toolkit. */
export const PATHWAY_COMPUTER_TOOL_NAMES = [
  "computer_activate_window",
  "computer_click",
  "computer_drag",
  "computer_get_accessibility_tree",
  "computer_get_cursor_position",
  "computer_get_screen_size",
  "computer_get_state",
  "computer_help",
  "computer_inspect",
  "computer_spaces",
  "computer_invoke_menu",
  "computer_kill_app",
  "computer_launch_app",
  "computer_list_apps",
  "computer_list_windows",
  "computer_move_cursor",
  "computer_paste",
  "computer_perform_action",
  "computer_press_key",
  "computer_read_clipboard",
  "computer_run",
  "computer_screenshot",
  "computer_scroll",
  "computer_select_text",
  "computer_set_app_visibility",
  "computer_set_value",
  "computer_set_window_frame",
  "computer_set_window_minimized",
  "computer_type_text",
  "computer_verify_state",
  "computer_wait",
  "computer_write_clipboard",
  "computer_zoom",
  // The cua-driver CDP browser family. Deliberately inside the Computer
  // namespace: these are the same capability (`computer`), the same
  // approval gate, and the same denial-card path as the desktop tools — they
  // merely dispatch over CDP rather than OS events. They must never collide
  // with the integrated `preview_*` surface, which is a different host.
  "computer_browser_state",
  "computer_browser_prepare",
  "computer_browser_navigate",
  "computer_browser_click",
  "computer_browser_type",
  "computer_browser_dialog",
  "computer_browser_upload",
  "computer_browser_download",
  "computer_browser_pointer",
  "computer_browser_press",
] as const;

export type PathwayComputerToolName = (typeof PATHWAY_COMPUTER_TOOL_NAMES)[number];

const PATHWAY_COMPUTER_TOOL_NAME_SET = new Set<string>(PATHWAY_COMPUTER_TOOL_NAMES);

function recordString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = Reflect.get(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Accept only the canonical toolkit name or the exact provider qualifications
 * used for Pathway's reserved MCP server. A similarly named tool from another
 * MCP server must continue through the provider's ordinary permission policy.
 */
export function canonicalPathwayComputerToolName(
  value: unknown,
): PathwayComputerToolName | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  const canonical = normalized.startsWith("mcp__pathway__")
    ? normalized.slice("mcp__pathway__".length)
    : normalized.startsWith("pathway_")
      ? normalized.slice("pathway_".length)
      : normalized;
  return PATHWAY_COMPUTER_TOOL_NAME_SET.has(canonical)
    ? (canonical as PathwayComputerToolName)
    : undefined;
}

/**
 * Provider callbacks must carry Pathway's namespace themselves. Bare canonical
 * names are safe only after a separate protocol field has proved the server
 * identity (for example Codex's `serverName`).
 */
export function qualifiedPathwayComputerToolName(
  value: unknown,
): PathwayComputerToolName | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized.startsWith("mcp__pathway__") && !normalized.startsWith("pathway_")) {
    return undefined;
  }
  return canonicalPathwayComputerToolName(normalized);
}

/**
 * Namespace-insensitive matcher for Computer calls at the MCP boundary.
 *
 * A session that was never granted computer control must still surface the
 * denial card path when the model reaches for a Computer tool, or the attempt
 * dies as a silent tool error and the user never learns control is off. The
 * MCP server denies an unknown tool name with `capability_denied` plus the
 * denial hook only when this matcher (or catalog membership) matches, so a
 * prefixed spelling from a session that never saw the catalog —
 * `pathway_computer_click`, `mcp__pathway__computer_click` — still reaches
 * the denial hook and the card.
 *
 * Entirely-unknown names (`computer_future_tool`, another server's
 * `mcp__other__computer_click`) must keep their current behavior — unknown
 * tools stay INVALID_PARAMS and foreign tools keep the provider's ordinary
 * permission policy — so this matcher accepts only exact owned names in any
 * of the three spellings, never prose around them.
 */
export function isPathwayComputerToolFamilyName(value: unknown): boolean {
  return canonicalPathwayComputerToolName(value) !== undefined;
}

function firstRecordString(value: unknown, keys: ReadonlyArray<string>): string | undefined {
  for (const key of keys) {
    const candidate = recordString(value, key);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

export function computerToolNameFromProviderPermission(input: {
  readonly name?: unknown;
  readonly title?: unknown;
  readonly rawInput?: unknown;
  readonly metadata?: unknown;
}): PathwayComputerToolName | undefined {
  const explicitName = typeof input.name === "string" ? input.name : undefined;
  if (explicitName !== undefined) return qualifiedPathwayComputerToolName(explicitName);

  const rawToolName = firstRecordString(input.rawInput, ["_toolName", "toolName", "tool_name"]);
  if (rawToolName !== undefined) return qualifiedPathwayComputerToolName(rawToolName);

  const metadataToolName = firstRecordString(input.metadata, [
    "_toolName",
    "toolName",
    "tool_name",
  ]);
  if (metadataToolName !== undefined) return qualifiedPathwayComputerToolName(metadataToolName);

  return qualifiedPathwayComputerToolName(input.title);
}

/**
 * The runtime modes whose provider policy asks the user about an MCP tool
 * call. Synara had only `approval-required`; Pathway's `auto-accept-edits`
 * still has the user review non-edit calls, so it needs the same skip.
 */
const USER_REVIEWED_RUNTIME_MODES: ReadonlySet<RuntimeMode> = new Set<RuntimeMode>([
  "approval-required",
  "auto-accept-edits",
]);

/**
 * Provider permission prompts are redundant for an active Pathway Computer
 * capability: the Computer toolkit performs the authoritative task-scoped
 * approval (ADR 0048).
 * Plan mode and requests outside an active turn remain fail-closed.
 */
export function shouldAllowPathwayComputerProviderTool(input: {
  readonly computerControlEnabled: boolean;
  readonly activeTurn: boolean;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly permission: Parameters<typeof computerToolNameFromProviderPermission>[0];
}): boolean {
  return (
    input.computerControlEnabled &&
    input.activeTurn &&
    USER_REVIEWED_RUNTIME_MODES.has(input.runtimeMode) &&
    input.interactionMode === "default" &&
    computerToolNameFromProviderPermission(input.permission) !== undefined
  );
}
