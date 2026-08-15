/**
 * Pure decoding and bounds for the remote environment command channel.
 *
 * `packages/contracts/src/cloudProject.ts` is the source of truth. Convex cannot depend on Effect
 * Schema, so this module mirrors the two command codecs closely enough that invalid records never
 * enter authoritative storage and returns their normalized wire representation to the mutation.
 *
 * @module environmentCommands
 */

export const ENVIRONMENT_COMMAND_ARGS_MAX_BYTES = 512 * 1024;
export const ENVIRONMENT_COMMAND_MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const ENVIRONMENT_COMMAND_CLAIM_TTL_MS = 90_000;
export const ENVIRONMENT_COMMAND_MAX_CLAIM_TTL_MS = 10 * 60 * 1000;

export const ENVIRONMENT_COMMAND_KINDS = [
  "startThread",
  "sendMessage",
  "interrupt",
  "statusQuery",
] as const;
export type EnvironmentCommandKind = (typeof ENVIRONMENT_COMMAND_KINDS)[number];

export const ENVIRONMENT_COMMAND_STATES = [
  "pending",
  "claimed",
  "succeeded",
  "failed",
  "canceled",
  "expired",
] as const;
export type EnvironmentCommandState = (typeof ENVIRONMENT_COMMAND_STATES)[number];

export type EnvironmentCommandArgs =
  | {
      readonly kind: "startThread";
      readonly prompt: string;
      readonly modelSelection: ModelSelection | null;
    }
  | { readonly kind: "sendMessage"; readonly threadId: string; readonly message: string }
  | { readonly kind: "interrupt"; readonly threadId: string }
  | { readonly kind: "statusQuery"; readonly threadId: string };

export type EnvironmentCommandResult =
  | { readonly kind: "startThread"; readonly threadId: string }
  | {
      readonly kind: "sendMessage";
      readonly threadId: string;
      readonly turnId: string | null;
    }
  | { readonly kind: "interrupt"; readonly threadId: string }
  | {
      readonly kind: "statusQuery";
      readonly threadId: string;
      readonly sessionStatus:
        | "idle"
        | "starting"
        | "running"
        | "ready"
        | "interrupted"
        | "stopped"
        | "error";
      readonly activeTurnId: string | null;
    };

type ProviderOptionSelection = { readonly id: string; readonly value: string | boolean };
type ModelSelection = {
  readonly instanceId: string;
  readonly model: string;
  readonly options?: readonly ProviderOptionSelection[];
};

export type DecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

class DecodeError extends Error {}

function invalid(message: string): never {
  throw new DecodeError(message);
}

function decode<T>(run: () => T): DecodeResult<T> {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    if (error instanceof DecodeError) return { ok: false, message: error.message };
    throw error;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function trimmed(value: unknown, label: string): string {
  if (typeof value !== "string") invalid(`${label} must be a string.`);
  const normalized = value.trim();
  if (normalized.length === 0) invalid(`${label} must be non-empty.`);
  return normalized;
}

function nullableId(value: unknown, label: string): string | null {
  return value === null ? null : trimmed(value, label);
}

function literal<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    invalid(`${label} must be one of ${values.join(", ")}.`);
  }
  return value as Values[number];
}

const PROVIDER_SLUG = /^[a-zA-Z][a-zA-Z0-9_-]*$/u;

function providerSlug(value: unknown, label: string): string {
  const slug = trimmed(value, label);
  if (slug.length > 64 || !PROVIDER_SLUG.test(slug)) {
    invalid(`${label} must be a provider instance slug.`);
  }
  return slug;
}

function optionSelections(value: unknown): readonly ProviderOptionSelection[] {
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const selection = record(item, `modelSelection.options[${index}]`);
      const optionValue = selection["value"];
      if (typeof optionValue !== "boolean" && typeof optionValue !== "string") {
        invalid(`modelSelection.options[${index}].value must be a string or boolean.`);
      }
      return {
        id: trimmed(selection["id"], `modelSelection.options[${index}].id`),
        value:
          typeof optionValue === "string"
            ? trimmed(optionValue, `modelSelection.options[${index}].value`)
            : optionValue,
      };
    });
  }

  const legacy = record(value, "modelSelection.options");
  const normalized: ProviderOptionSelection[] = [];
  for (const [rawId, rawValue] of Object.entries(legacy)) {
    const id = rawId.trim();
    if (id.length === 0) continue;
    if (typeof rawValue === "boolean") normalized.push({ id, value: rawValue });
    if (typeof rawValue === "string" && rawValue.trim().length > 0) {
      normalized.push({ id, value: rawValue.trim() });
    }
  }
  return normalized;
}

function modelSelection(value: unknown): ModelSelection | null {
  if (value === null) return null;
  const source = record(value, "modelSelection");
  const instanceIdSource =
    source["instanceId"] !== undefined
      ? source["instanceId"]
      : typeof source["provider"] === "string"
        ? source["provider"]
        : undefined;
  if (instanceIdSource === undefined) invalid("modelSelection.instanceId is required.");
  const decoded: ModelSelection = {
    instanceId: providerSlug(instanceIdSource, "modelSelection.instanceId"),
    model: trimmed(source["model"], "modelSelection.model"),
  };
  return source["options"] === undefined
    ? decoded
    : { ...decoded, options: optionSelections(source["options"]) };
}

/** Decodes and normalizes one `EnvironmentCommandArgs` value. */
export function decodeEnvironmentCommandArgs(value: unknown): DecodeResult<EnvironmentCommandArgs> {
  return decode(() => {
    const source = record(value, "Command arguments");
    const kind = literal(source["kind"], ENVIRONMENT_COMMAND_KINDS, "Command arguments.kind");
    switch (kind) {
      case "startThread":
        return {
          kind,
          prompt: trimmed(source["prompt"], "Command arguments.prompt"),
          modelSelection: modelSelection(source["modelSelection"]),
        };
      case "sendMessage":
        return {
          kind,
          threadId: trimmed(source["threadId"], "Command arguments.threadId"),
          message: trimmed(source["message"], "Command arguments.message"),
        };
      case "interrupt":
      case "statusQuery":
        return { kind, threadId: trimmed(source["threadId"], "Command arguments.threadId") };
    }
  });
}

const SESSION_STATUSES = [
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
] as const;

/** Decodes and normalizes one non-null `EnvironmentCommandResult` value. */
export function decodeEnvironmentCommandResult(
  value: unknown,
): DecodeResult<EnvironmentCommandResult> {
  return decode(() => {
    const source = record(value, "Command result");
    const kind = literal(source["kind"], ENVIRONMENT_COMMAND_KINDS, "Command result.kind");
    const threadId = trimmed(source["threadId"], "Command result.threadId");
    switch (kind) {
      case "startThread":
      case "interrupt":
        return { kind, threadId };
      case "sendMessage":
        return { kind, threadId, turnId: nullableId(source["turnId"], "Command result.turnId") };
      case "statusQuery":
        return {
          kind,
          threadId,
          sessionStatus: literal(
            source["sessionStatus"],
            SESSION_STATUSES,
            "Command result.sessionStatus",
          ),
          activeTurnId: nullableId(source["activeTurnId"], "Command result.activeTurnId"),
        };
    }
  });
}

export function isCancellableEnvironmentCommand(state: EnvironmentCommandState): boolean {
  return state === "pending";
}

export function environmentCommandPermission(
  kind: EnvironmentCommandKind,
): "remoteAgents.control" | "environments.read" {
  return kind === "statusQuery" ? "environments.read" : "remoteAgents.control";
}
