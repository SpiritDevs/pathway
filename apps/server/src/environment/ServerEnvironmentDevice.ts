import type { ExecutionEnvironmentDevice } from "@spiritdevs/contracts";
import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import * as Effect from "effect/Effect";

import * as ProcessRunner from "../processRunner.ts";

const MAC_HARDWARE_PROFILE_TIMEOUT = "5 seconds";
const MAC_HARDWARE_PROFILE_MAX_BYTES = 128 * 1024;

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function macDeviceKind(input: {
  readonly model?: string;
  readonly modelIdentifier?: string;
}): ExecutionEnvironmentDevice["kind"] {
  const candidate = `${input.model ?? ""} ${input.modelIdentifier ?? ""}`.toLowerCase();
  if (candidate.includes("macbook")) return "laptop";
  if (
    candidate.includes("mac studio") ||
    candidate.includes("mac mini") ||
    candidate.includes("mac pro") ||
    candidate.includes("imac")
  ) {
    return "desktop";
  }
  return "unknown";
}

export function parseMacHardwareProfile(
  raw: string,
  hostname: string,
): ExecutionEnvironmentDevice | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const rows = (parsed as Record<string, unknown>)["SPHardwareDataType"];
    if (!Array.isArray(rows)) return null;
    const first = rows[0];
    if (typeof first !== "object" || first === null) return null;
    const record = first as Record<string, unknown>;
    const model = nonEmptyString(record["machine_name"]);
    const modelIdentifier = nonEmptyString(record["machine_model"]);
    return {
      kind: macDeviceKind({
        ...(model ? { model } : {}),
        ...(modelIdentifier ? { modelIdentifier } : {}),
      }),
      ...(nonEmptyString(hostname) ? { hostname: hostname.trim() } : {}),
      ...(model ? { model } : {}),
      ...(modelIdentifier ? { modelIdentifier } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Collects only display-safe hardware fields. The macOS probe also returns serial numbers and
 * stable hardware identifiers, so parsing is deliberately allow-listed rather than spreading the
 * command result into the environment descriptor.
 */
export const resolveServerEnvironmentDevice = Effect.fn("resolveServerEnvironmentDevice")(
  function* (hostname: string) {
    const platform = yield* HostProcessPlatform;
    const fallback: ExecutionEnvironmentDevice = {
      kind: "unknown",
      ...(nonEmptyString(hostname) ? { hostname: hostname.trim() } : {}),
    };
    if (platform !== "darwin") return fallback;

    const processRunner = yield* ProcessRunner.ProcessRunner;
    const result = yield* processRunner
      .run({
        command: "system_profiler",
        args: ["SPHardwareDataType", "-json"],
        timeout: MAC_HARDWARE_PROFILE_TIMEOUT,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: MAC_HARDWARE_PROFILE_MAX_BYTES,
        outputMode: "truncate",
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logDebug("Failed to inspect environment hardware profile.").pipe(
            Effect.annotateLogs({ platform, cause }),
            Effect.as(null),
          ),
        ),
      );

    if (result === null || result.code !== 0 || result.timedOut) return fallback;
    return parseMacHardwareProfile(result.stdout, hostname) ?? fallback;
  },
);
