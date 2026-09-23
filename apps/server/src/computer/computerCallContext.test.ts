import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";

import {
  ComputerCallTiming,
  createComputerCallContext,
  cuaActionSettleMsOverride,
  cuaCaptureReuseEnabled,
  cuaConditionalSettleEnabled,
  cuaPreviewStillMsOverride,
  cuaTimingLogEnabled,
  currentComputerCall,
  markComputerCall,
  timedComputerLeg,
  withComputerCallContext,
} from "./computerCallContext.ts";

const FLAGS = [
  "PATHWAY_CUA_TIMING_LOG",
  "PATHWAY_CUA_CONDITIONAL_SETTLE",
  "PATHWAY_CUA_ACTION_SETTLE_MS",
  "PATHWAY_CUA_CAPTURE_REUSE",
  "PATHWAY_CUA_PREVIEW_STILL_MS",
] as const;

const saved = new Map<string, string | undefined>();
for (const flag of FLAGS) saved.set(flag, process.env[flag]);

afterEach(() => {
  for (const flag of FLAGS) {
    const value = saved.get(flag);
    if (value === undefined) delete process.env[flag];
    else process.env[flag] = value;
  }
});

/** Runs `effect` with a logger that records every message. */
const withCapturedLogs = <A, E>(effect: (lines: string[]) => Effect.Effect<A, E>) => {
  const lines: string[] = [];
  const logger = Logger.make(({ message }) => {
    lines.push(Array.isArray(message) ? message.map(String).join(" ") : String(message));
  });
  return effect(lines).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
};

describe("computer call env flags", () => {
  it.each(FLAGS)("defaults %s to its shipped state", (flag) => {
    delete process.env[flag];
    expect(cuaTimingLogEnabled()).toBe(false);
    // Graduated flags ship on; the env var is now only a kill switch.
    expect(cuaConditionalSettleEnabled()).toBe(true);
    expect(cuaCaptureReuseEnabled()).toBe(true);
    expect(cuaActionSettleMsOverride()).toBeUndefined();
    expect(cuaPreviewStillMsOverride()).toBeUndefined();
  });

  it.each(["1", "true", "on", "yes", " TRUE ", "On"])(
    "treats %s as enabled for the boolean flags",
    (value) => {
      process.env.PATHWAY_CUA_TIMING_LOG = value;
      process.env.PATHWAY_CUA_CONDITIONAL_SETTLE = value;
      process.env.PATHWAY_CUA_CAPTURE_REUSE = value;
      expect(cuaTimingLogEnabled()).toBe(true);
      expect(cuaConditionalSettleEnabled()).toBe(true);
      expect(cuaCaptureReuseEnabled()).toBe(true);
    },
  );

  it.each(["0", "false", "off", "no"])(
    "treats %s as disabled for the graduated flags' kill switch",
    (value) => {
      process.env.PATHWAY_CUA_CONDITIONAL_SETTLE = value;
      process.env.PATHWAY_CUA_CAPTURE_REUSE = value;
      expect(cuaConditionalSettleEnabled()).toBe(false);
      expect(cuaCaptureReuseEnabled()).toBe(false);
    },
  );

  it.each(["0", "false", "off", "no", "2", "enabled"])(
    "treats %s as disabled for the opt-in boolean flags",
    (value) => {
      process.env.PATHWAY_CUA_TIMING_LOG = value;
      expect(cuaTimingLogEnabled()).toBe(false);
    },
  );

  it.each(["2", "enabled", "anything"])(
    "keeps the graduated flags on for a non-off value like %s",
    (value) => {
      process.env.PATHWAY_CUA_CONDITIONAL_SETTLE = value;
      process.env.PATHWAY_CUA_CAPTURE_REUSE = value;
      expect(cuaConditionalSettleEnabled()).toBe(true);
      expect(cuaCaptureReuseEnabled()).toBe(true);
    },
  );

  it("parses PATHWAY_CUA_ACTION_SETTLE_MS as a non-negative number", () => {
    process.env.PATHWAY_CUA_ACTION_SETTLE_MS = "0";
    expect(cuaActionSettleMsOverride()).toBe(0);
    process.env.PATHWAY_CUA_ACTION_SETTLE_MS = "175";
    expect(cuaActionSettleMsOverride()).toBe(175);
    process.env.PATHWAY_CUA_ACTION_SETTLE_MS = " 80 ";
    expect(cuaActionSettleMsOverride()).toBe(80);
  });

  it.each(["", "   ", "abc", "-5", "NaN"])(
    "ignores the unparsable PATHWAY_CUA_ACTION_SETTLE_MS value %s",
    (value) => {
      process.env.PATHWAY_CUA_ACTION_SETTLE_MS = value;
      expect(cuaActionSettleMsOverride()).toBeUndefined();
    },
  );

  it("parses PATHWAY_CUA_PREVIEW_STILL_MS as a positive number", () => {
    process.env.PATHWAY_CUA_PREVIEW_STILL_MS = "4000";
    expect(cuaPreviewStillMsOverride()).toBe(4000);
    process.env.PATHWAY_CUA_PREVIEW_STILL_MS = " 250 ";
    expect(cuaPreviewStillMsOverride()).toBe(250);
  });

  it.each(["", "abc", "0", "-100", "NaN"])(
    "ignores the unparsable PATHWAY_CUA_PREVIEW_STILL_MS value %s",
    (value) => {
      process.env.PATHWAY_CUA_PREVIEW_STILL_MS = value;
      expect(cuaPreviewStillMsOverride()).toBeUndefined();
    },
  );
});

describe("createComputerCallContext", () => {
  it.effect("creates no context at all when both consumers are off", () =>
    Effect.gen(function* () {
      delete process.env.PATHWAY_CUA_TIMING_LOG;
      process.env.PATHWAY_CUA_CONDITIONAL_SETTLE = "0";
      expect(yield* createComputerCallContext).toBeUndefined();
    }),
  );

  it.effect("creates a context with a timing record under PATHWAY_CUA_TIMING_LOG", () =>
    Effect.gen(function* () {
      process.env.PATHWAY_CUA_TIMING_LOG = "1";
      expect((yield* createComputerCallContext)?.timing).toBeInstanceOf(ComputerCallTiming);
    }),
  );

  it.effect(
    "creates a context without a timing record under PATHWAY_CUA_CONDITIONAL_SETTLE alone",
    () =>
      Effect.gen(function* () {
        process.env.PATHWAY_CUA_CONDITIONAL_SETTLE = "1";
        const context = yield* createComputerCallContext;
        expect(context).toBeDefined();
        expect(context?.timing).toBeUndefined();
      }),
  );
});

describe("ComputerCallContext", () => {
  it.effect("hands the action proof to the post-action observer exactly once", () =>
    Effect.gen(function* () {
      process.env.PATHWAY_CUA_CONDITIONAL_SETTLE = "1";
      const context = (yield* createComputerCallContext)!;
      context.recordActionProof({ effect: "verified", verified: "confirmed" });
      expect(context.takeActionProof()).toEqual({
        effect: "verified",
        verified: "confirmed",
      });
      expect(context.takeActionProof()).toBeUndefined();
    }),
  );

  it.effect("keeps only the latest action's verdict", () =>
    Effect.gen(function* () {
      process.env.PATHWAY_CUA_CONDITIONAL_SETTLE = "1";
      const context = (yield* createComputerCallContext)!;
      context.recordActionProof({ effect: "verified" });
      context.recordActionProof({ effect: "dispatched-unknown" });
      expect(context.takeActionProof()).toEqual({ effect: "dispatched-unknown" });
    }),
  );

  it.effect("shares one context across a whole wrapped call and finishes it once", () =>
    withCapturedLogs((lines) =>
      Effect.gen(function* () {
        process.env.PATHWAY_CUA_TIMING_LOG = "1";
        const context = (yield* createComputerCallContext)!;
        let inside: unknown;
        yield* withComputerCallContext(
          context,
          Effect.gen(function* () {
            inside = yield* currentComputerCall;
            yield* markComputerCall("computer_click");
            yield* timedComputerLeg("dispatch", TestClock.adjust("15 millis"));
            yield* timedComputerLeg("settle", Effect.void);
            context.timing?.count("settle_skipped");
            yield* context.timing!.finish();
            yield* context.timing!.finish();
          }),
        );
        expect(inside).toBe(context);
        expect(yield* currentComputerCall).toBeUndefined();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("[computer-timing]");
        expect(lines[0]).toContain("op=computer_click");
        expect(lines[0]).toContain("dispatch_ms=15.0");
        expect(lines[0]).toContain("settle_ms=");
        expect(lines[0]).toContain("settle_skipped=1");
        expect(lines[0]).toContain("total_ms=15.0");
        expect(lines[0]).not.toContain("failed=1");
      }),
    ),
  );

  it.effect("timedComputerLeg is a passthrough outside a call context", () =>
    Effect.gen(function* () {
      expect(yield* currentComputerCall).toBeUndefined();
      expect(yield* timedComputerLeg("dispatch", Effect.succeed(7))).toBe(7);
    }),
  );

  it.effect("marks failures on the call's timing line", () =>
    withCapturedLogs((lines) =>
      Effect.gen(function* () {
        process.env.PATHWAY_CUA_TIMING_LOG = "1";
        const context = (yield* createComputerCallContext)!;
        const failure = yield* withComputerCallContext(
          context,
          Effect.gen(function* () {
            context.timing?.markFailed();
            yield* context.timing!.finish();
            return yield* Effect.fail("boom");
          }),
        ).pipe(Effect.flip);
        expect(failure).toBe("boom");
        expect(lines[0]).toContain("failed=1");
      }),
    ),
  );

  it.effect("records a failed leg's duration too", () =>
    Effect.gen(function* () {
      const timing = new ComputerCallTiming(0);
      yield* timing
        .span("dispatch", TestClock.adjust("20 millis").pipe(Effect.andThen(Effect.fail("x"))))
        .pipe(Effect.flip);
      const lines: string[] = [];
      yield* timing.finish().pipe(
        Effect.provide(
          Logger.layer([Logger.make(({ message }) => lines.push(String(message)))], {
            mergeWithExisting: false,
          }),
        ),
      );
      expect(lines[0]).toContain("dispatch_ms=20.0");
    }),
  );

  it.effect("expires the context in a detached continuation once the call ends", () =>
    Effect.gen(function* () {
      process.env.PATHWAY_CUA_CONDITIONAL_SETTLE = "1";
      const context = (yield* createComputerCallContext)!;
      const gate = yield* Deferred.make<void>();
      const detached = yield* withComputerCallContext(
        context,
        Effect.forkDetach(Effect.andThen(Deferred.await(gate), currentComputerCall)),
      );
      yield* Deferred.succeed(gate, undefined);
      expect(yield* Fiber.join(detached)).toBeUndefined();
    }),
  );
});
