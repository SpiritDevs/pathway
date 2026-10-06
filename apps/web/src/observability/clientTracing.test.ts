import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const tracing = vi.hoisted(() => ({
  spans: [] as { name: string; start: bigint; end?: bigint }[],
}));
vi.mock("../environments/primary", () => ({
  resolvePrimaryEnvironmentHttpUrl: () => "http://example.test/api/observability/v1/traces",
}));
vi.mock("../environments/primary/httpLayer", async () => {
  const Layer = await import("effect/Layer");
  return { primaryEnvironmentHttpLayer: Layer.empty };
});
vi.mock("effect/unstable/observability", async () => {
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const Tracer = await import("effect/Tracer");
  return {
    OtlpExporter: { layerFlusher: Layer.empty },
    OtlpSerialization: { layerJson: Layer.empty },
    OtlpTracer: {
      make: () =>
        Effect.succeed(
          Tracer.make({
            span(options) {
              const recorded = { name: options.name, start: options.startTime } as {
                name: string;
                start: bigint;
                end?: bigint;
              };
              tracing.spans.push(recorded);
              const span = new Tracer.NativeSpan(options);
              const end = span.end.bind(span);
              span.end = (at, exit) => {
                recorded.end = at;
                end(at, exit);
              };
              return span;
            },
          }),
        ),
    },
  };
});
import {
  __resetClientTracingForTests,
  configureClientTracing,
  recordShellStartupMilestone,
} from "./clientTracing";

afterEach(async () => {
  await __resetClientTracingForTests();
  tracing.spans.length = 0;
  performance.clearMarks("web.startup.cachedShellPainted");
  performance.clearMarks("web.startup.liveShellSynced");
});

describe("shell startup tracing", () => {
  it("buffers the paint timestamp until authentication enables export and records it once", async () => {
    recordShellStartupMilestone("cachedShellPainted");
    const marks = performance.getEntriesByName("web.startup.cachedShellPainted");
    expect(marks).toHaveLength(1);
    expect(tracing.spans).toHaveLength(0);
    recordShellStartupMilestone("cachedShellPainted");
    await configureClientTracing();
    expect(tracing.spans).toHaveLength(1);
    expect(tracing.spans[0]).toEqual({
      name: "web.startup.cachedShellPainted",
      start: BigInt(Math.round(performance.timeOrigin * 1_000_000)),
      end: BigInt(Math.round((performance.timeOrigin + marks[0]!.startTime) * 1_000_000)),
    });
    await configureClientTracing({ exportIntervalMs: 250 });
    expect(tracing.spans).toHaveLength(1);
  });
  it("exports live synchronization after cached paint with separate performance marks", async () => {
    await configureClientTracing();
    recordShellStartupMilestone("cachedShellPainted");
    recordShellStartupMilestone("liveShellSynced");
    recordShellStartupMilestone("liveShellSynced");
    expect(tracing.spans.map((span) => span.name)).toEqual([
      "web.startup.cachedShellPainted",
      "web.startup.liveShellSynced",
    ]);
    expect(tracing.spans[1]!.end! >= tracing.spans[0]!.end!).toBe(true);
    expect(performance.getEntriesByName("web.startup.liveShellSynced")).toHaveLength(1);
  });
});
