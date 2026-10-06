import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Tracer from "effect/Tracer";

const clock = vi.hoisted(() => ({ time: 1250 }));
vi.mock("node:perf_hooks", () => ({
  performance: { timeOrigin: 1000, now: () => clock.time - 1000 },
}));

beforeEach(() => {
  vi.resetModules();
  clock.time = 1250;
});
afterEach(() => vi.unstubAllEnvs());

function collectSpans() {
  const spans: Tracer.Span[] = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { spans, tracer };
}

it("replays module and config spans with their original timestamps", async () => {
  vi.stubEnv("PATHWAY_DESKTOP_BACKEND_SPAWN_TIME_MS", "900");
  const trace = await import("./serverStartupTrace.ts");
  const { spans, tracer } = collectSpans();
  trace.recordServerModulesLoaded();
  expect(process.env.PATHWAY_DESKTOP_BACKEND_SPAWN_TIME_MS).toBeUndefined();
  clock.time = 1300;
  trace.endServerStartupPhase("server.startup.commandDispatch");
  trace.beginServerStartupPhase("server.startup.config");
  clock.time = 1400;
  trace.endServerStartupPhase("server.startup.config");
  trace.installServerStartupTracer(tracer);
  expect(spans.map((span) => span.name)).toEqual([
    "server.startup.processInitialization",
    "server.startup.moduleLoad",
    "server.startup.commandDispatch",
    "server.startup.config",
  ]);
  expect(spans.map((span) => span.status)).toMatchObject([
    { _tag: "Ended", startTime: 900_000_000n, endTime: 1_000_000_000n },
    { _tag: "Ended", startTime: 1_000_000_000n, endTime: 1_250_000_000n },
    { _tag: "Ended", startTime: 1_250_000_000n, endTime: 1_300_000_000n },
    { _tag: "Ended", startTime: 1_300_000_000n, endTime: 1_400_000_000n },
  ]);
  trace.beginServerStartupPhase("server.startup.layerConstruction");
  clock.time = 1600;
  trace.endServerStartupPhase("server.startup.layerConstruction");
  trace.endServerStartupPhase("server.startup.layerConstruction");
  expect(spans).toHaveLength(5);
  expect(spans[4]?.status).toMatchObject({
    _tag: "Ended",
    startTime: 1_400_000_000n,
    endTime: 1_600_000_000n,
  });
});

it("leaves imported server modules inert until the CLI entry starts tracing", async () => {
  const trace = await import("./serverStartupTrace.ts");
  const { spans, tracer } = collectSpans();
  trace.installServerStartupTracer(tracer);
  trace.beginServerStartupPhase("unused");
  trace.endServerStartupPhase("unused");
  expect(spans).toHaveLength(0);
});

it("ignores invalid spawn timestamps", async () => {
  vi.stubEnv("PATHWAY_DESKTOP_BACKEND_SPAWN_TIME_MS", "invalid");
  const trace = await import("./serverStartupTrace.ts");
  const { spans, tracer } = collectSpans();
  trace.recordServerModulesLoaded();
  trace.installServerStartupTracer(tracer);
  expect(spans.map((span) => span.name)).toEqual(["server.startup.moduleLoad"]);
});
