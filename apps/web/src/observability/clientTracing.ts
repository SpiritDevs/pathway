import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";
import { HttpClient } from "effect/unstable/http";
import { OtlpExporter, OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

import {
  settleAsyncResult,
  squashAtomCommandFailure,
} from "@spiritdevs/client-runtime/state/runtime";
import { safeErrorLogAttributes } from "@spiritdevs/client-runtime/errors";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary";
import { primaryEnvironmentHttpLayer } from "../environments/primary/httpLayer";
import { isElectron } from "../env";
import { APP_VERSION } from "~/branding";

const DEFAULT_EXPORT_INTERVAL_MS = 1_000;
const CLIENT_TRACING_RESOURCE = {
  serviceName: "pathway-web",
  attributes: {
    "service.runtime": "pathway-web",
    "service.mode": isElectron ? "electron" : "browser",
    "service.version": APP_VERSION,
  },
} as const;

const delegateRuntimeLayer = Layer.mergeAll(
  primaryEnvironmentHttpLayer,
  OtlpExporter.layerFlusher,
  OtlpSerialization.layerJson,
  Layer.succeed(HttpClient.TracerDisabledWhen, () => true),
);

let activeDelegate: Tracer.Tracer | null = null;
let activeRuntime: ManagedRuntime.ManagedRuntime<never, never> | null = null;
let activeScope: Scope.Closeable | null = null;
let activeConfigKey: string | null = null;
let configurationGeneration = 0;
let pendingConfiguration = Promise.resolve();

const shellMilestones = new Map<string, number>();
const exportedShellMilestones = new Set<string>();

function exportShellMilestone(name: string, completedAt: number): void {
  if (activeDelegate === null || exportedShellMilestones.has(name)) return;
  const span = activeDelegate.span({
    name,
    parent: Option.none(),
    annotations: Context.empty(),
    links: [],
    startTime: BigInt(Math.round(performance.timeOrigin * 1_000_000)),
    kind: "internal",
    root: true,
    sampled: true,
  });
  span.end(BigInt(Math.round((performance.timeOrigin + completedAt) * 1_000_000)), Exit.void);
  exportedShellMilestones.add(name);
}

// Buffer the original paint timestamp until backend auth enables the exporter.
export function recordShellStartupMilestone(kind: "cachedShellPainted" | "liveShellSynced"): void {
  const name = `web.startup.${kind}`;
  if (shellMilestones.has(name)) return;
  const completedAt = performance.now();
  shellMilestones.set(name, completedAt);
  performance.mark(name, { startTime: completedAt });
  exportShellMilestone(name, completedAt);
}

export interface ClientTracingConfig {
  readonly exportIntervalMs?: number;
}

export const ClientTracingLive = Layer.succeed(
  Tracer.Tracer,
  Tracer.make({
    span(options) {
      return activeDelegate?.span(options) ?? new Tracer.NativeSpan(options);
    },
  }),
);

export function configureClientTracing(config: ClientTracingConfig = {}): Promise<void> {
  if (config.exportIntervalMs === undefined && activeConfigKey !== null) {
    return pendingConfiguration;
  }
  pendingConfiguration = pendingConfiguration.finally(() => applyClientTracingConfig(config));
  return pendingConfiguration;
}

async function applyClientTracingConfig(config: ClientTracingConfig): Promise<void> {
  const otlpTracesUrl = resolvePrimaryEnvironmentHttpUrl("/api/observability/v1/traces");
  const exportIntervalMs = Math.max(10, config.exportIntervalMs ?? DEFAULT_EXPORT_INTERVAL_MS);
  const nextConfigKey = `${otlpTracesUrl}|${exportIntervalMs}`;

  if (activeConfigKey === nextConfigKey && activeDelegate !== null) {
    return;
  }

  activeConfigKey = nextConfigKey;
  const generation = ++configurationGeneration;

  const previousRuntime = activeRuntime;
  const previousScope = activeScope;

  activeDelegate = null;
  activeRuntime = null;
  activeScope = null;

  await disposeTracerRuntime(previousRuntime, previousScope);

  const runtime = ManagedRuntime.make(delegateRuntimeLayer);
  const scope = runtime.runSync(Scope.make());

  const delegateResult = await settleAsyncResult(() =>
    runtime.runPromiseExit(
      Scope.provide(scope)(
        OtlpTracer.make({
          url: otlpTracesUrl,
          exportInterval: `${exportIntervalMs} millis`,
          resource: CLIENT_TRACING_RESOURCE,
        }),
      ),
    ),
  );
  if (delegateResult._tag === "Failure") {
    await disposeTracerRuntime(runtime, scope);

    if (generation === configurationGeneration) {
      const error = squashAtomCommandFailure(delegateResult);
      const tracesUrl = new URL(otlpTracesUrl);
      console.warn("Failed to configure client tracing exporter", {
        scheme: tracesUrl.protocol.replace(/:$/, ""),
        host: tracesUrl.hostname,
        port: tracesUrl.port || undefined,
        exportIntervalMs,
        ...safeErrorLogAttributes(error),
      });
    }
    return;
  }

  if (generation !== configurationGeneration) {
    await disposeTracerRuntime(runtime, scope);
    return;
  }

  activeDelegate = delegateResult.value;
  for (const [name, completedAt] of shellMilestones) exportShellMilestone(name, completedAt);
  activeRuntime = runtime;
  activeScope = scope;
}

async function disposeTracerRuntime(
  runtime: ManagedRuntime.ManagedRuntime<never, never> | null,
  scope: Scope.Closeable | null,
): Promise<void> {
  if (runtime === null || scope === null) {
    return;
  }

  await settleAsyncResult(() => runtime.runPromiseExit(Scope.close(scope, Exit.void)));
  runtime.dispose();
}

export async function __resetClientTracingForTests() {
  configurationGeneration++;
  shellMilestones.clear();
  exportedShellMilestones.clear();
  activeConfigKey = null;
  activeDelegate = null;
  pendingConfiguration = Promise.resolve();

  const runtime = activeRuntime;
  const scope = activeScope;
  activeRuntime = null;
  activeScope = null;

  await disposeTracerRuntime(runtime, scope);
}
