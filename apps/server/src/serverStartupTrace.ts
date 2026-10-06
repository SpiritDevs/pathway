// @effect-diagnostics nodeBuiltinImport:off
import * as NodePerfHooks from "node:perf_hooks";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type * as Tracer from "effect/Tracer";

const phases = new Map<string, number>();
const completed: Array<{ name: string; start: number; end: number }> = [];
let tracer: Tracer.Tracer | undefined;
let enabled = false;
const now = () => NodePerfHooks.performance.timeOrigin + NodePerfHooks.performance.now();
const nanos = (millis: number) => BigInt(Math.round(millis * 1_000_000));

function record(name: string, start: number, end: number) {
  if (tracer === undefined) {
    completed.push({ name, start, end });
    return;
  }
  const span = tracer.span({
    name,
    startTime: nanos(start),
    parent: Option.none(),
    annotations: Context.empty(),
    links: [],
    kind: "internal",
    root: true,
    sampled: true,
  });
  span.attribute("process.pid", process.pid);
  span.end(nanos(end), Exit.void);
}

/** Static entry imports have completed; timeOrigin includes the Node module loader and its dependencies. */
export function recordServerModulesLoaded() {
  enabled = true;
  const spawnedAt = Number(process.env.PATHWAY_DESKTOP_BACKEND_SPAWN_TIME_MS);
  if (
    Number.isFinite(spawnedAt) &&
    spawnedAt > 0 &&
    spawnedAt <= NodePerfHooks.performance.timeOrigin
  ) {
    record("server.startup.processInitialization", spawnedAt, NodePerfHooks.performance.timeOrigin);
  }
  delete process.env.PATHWAY_DESKTOP_BACKEND_SPAWN_TIME_MS;
  record("server.startup.moduleLoad", NodePerfHooks.performance.timeOrigin, now());
  beginServerStartupPhase("server.startup.commandDispatch");
}

export function beginServerStartupPhase(name: string) {
  if (enabled) phases.set(name, now());
}

export function endServerStartupPhase(name: string) {
  const start = phases.get(name);
  if (start === undefined) return;
  phases.delete(name);
  record(name, start, now());
}

/** Replay pre-observability spans with their original timestamps once the local file tracer exists. */
export function installServerStartupTracer(value: Tracer.Tracer) {
  tracer = value;
  for (const phase of completed.splice(0)) record(phase.name, phase.start, phase.end);
}
