import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeFakeHelperSpawner } from "../testing/FakeHelperSpawner.ts";
import {
  analyzeFocusSamples,
  type FocusProbeSample,
  parseFocusProbeLine,
  resolveFocusProbePath,
  startFocusProbe,
} from "./focusProbe.ts";

const sample = (t: number, overrides: Partial<FocusProbeSample> = {}): FocusProbeSample => ({
  t,
  pid: 100,
  app: "Human App",
  keyWin: 5001,
  keyTitle: "human.txt",
  topWin: 5001,
  topTitle: "human.txt",
  space: 7,
  focusedPid: 100,
  focused: "100:AXTextArea:human.txt",
  ...overrides,
});

const span = (start: number, count: number, step = 20, overrides = {}): FocusProbeSample[] =>
  Array.from({ length: count }, (_, index) => sample(start + index * step, overrides));

describe("parseFocusProbeLine", () => {
  it("parses meta, sample and done lines", () => {
    expect(
      parseFocusProbeLine(
        '{"kind":"meta","pid":9,"hz":50,"axTrusted":true,"axWindowSymbol":true,' +
          '"slsSpace":true,"stdinWatch":true,"label":"x","startedAt":1.5}',
      ),
    ).toEqual({
      kind: "meta",
      meta: {
        pid: 9,
        hz: 50,
        axTrusted: true,
        axWindowSymbol: true,
        slsSpace: true,
        stdinWatch: true,
        label: "x",
        startedAt: 1.5,
      },
    });
    expect(
      parseFocusProbeLine(
        '{"t":12.5,"pid":100,"app":"A","keyWin":1,"keyTitle":"k","topWin":2,' +
          '"topTitle":"t","space":3,"focused":"100:AXTextArea:f"}',
      ),
    ).toEqual({
      kind: "sample",
      sample: {
        t: 12.5,
        pid: 100,
        app: "A",
        keyWin: 1,
        keyTitle: "k",
        topWin: 2,
        topTitle: "t",
        space: 3,
        focusedPid: null,
        focused: "100:AXTextArea:f",
      },
    });
    expect(
      parseFocusProbeLine(
        '{"kind":"done","samples":4,"elapsedMs":80.2,"overruns":0,"stoppedBy":"stdin"}',
      ),
    ).toEqual({
      kind: "done",
      done: { samples: 4, elapsedMs: 80.2, overruns: 0, stoppedBy: "stdin" },
    });
  });

  it("tolerates null fields, blank lines and foreign output", () => {
    const parsed = parseFocusProbeLine('{"t":0,"pid":null,"app":null,"keyWin":null}');
    expect(parsed?.kind).toBe("sample");
    expect(parseFocusProbeLine("")).toBeNull();
    expect(parseFocusProbeLine("   ")).toBeNull();
    expect(parseFocusProbeLine("not json")).toBeNull();
    expect(parseFocusProbeLine('{"unrelated":true}')).toBeNull();
    expect(parseFocusProbeLine("[1,2,3]")).toBeNull();
  });
});

describe("analyzeFocusSamples", () => {
  it("reports theft-free on a stable stream", () => {
    const report = analyzeFocusSamples(span(0, 60));
    expect(report.theftFree).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.offBaseline).toEqual([]);
    expect(report.baseline).toEqual({
      pid: 100,
      keyWin: 5001,
      topWin: 5001,
      space: 7,
      focusedPid: 100,
      focused: "100:AXTextArea:human.txt",
    });
    expect(report.issues).toEqual([]);
  });

  it("flags a frontmost-pid change with its interval and observed state", () => {
    const samples = [
      ...span(0, 30),
      ...span(600, 5, 20, { pid: 200, app: "Agent App", keyWin: 9001, topWin: 9001 }),
      ...span(700, 25),
    ];
    const report = analyzeFocusSamples(samples);
    expect(report.theftFree).toBe(false);
    expect(report.offBaseline).toHaveLength(1);
    const theft = report.offBaseline[0]!;
    expect(theft.index).toBe(30);
    expect(theft.tMs).toBe(600);
    expect(theft.sampleCount).toBe(5);
    expect(theft.durationMs).toBe(80);
    expect(theft.changedFields).toEqual(expect.arrayContaining(["pid", "keyWin", "topWin"]));
    expect(theft.observed[0]).toMatchObject({ pid: 200, app: "Agent App", keyWin: 9001 });
  });

  it("flags typing-focus theft when the focused element's owner moves", () => {
    // The Codex case: kCPSNotifyTypingFocusChanged semantics — key focus can
    // move to the desktop/menubar/agent app while frontmostApplication still
    // reports the human's app. focusedPid catches what pid+keyWin miss.
    const samples = [
      ...span(0, 30),
      ...span(600, 5, 20, { focusedPid: 573, focused: "573:AXGroup:desktop" }),
      ...span(700, 25),
    ];
    const report = analyzeFocusSamples(samples);
    expect(report.theftFree).toBe(false);
    expect(report.offBaseline[0]!.changedFields).toEqual(["focusedPid"]);
    expect(report.offBaseline[0]!.observed[0]).toMatchObject({ focusedPid: 573 });
  });

  it("flags separate theft intervals around a return to baseline", () => {
    const samples = [
      ...span(0, 20),
      ...span(400, 3, 20, { pid: 200, app: "Agent" }),
      ...span(460, 10),
      ...span(660, 2, 20, { space: 8 }),
      ...span(700, 20),
    ];
    const report = analyzeFocusSamples(samples);
    expect(report.offBaseline).toHaveLength(2);
    expect(report.offBaseline[0]!.changedFields).toEqual(["pid"]);
    expect(report.offBaseline[1]!.changedFields).toEqual(["space"]);
    expect(report.offBaselineSamples).toBe(5);
  });

  it("excludes the settle window from violations and derives a modal baseline", () => {
    const samples = [
      // Warm-up: still settling from the launcher's activation.
      sample(0, { pid: 50, app: "Launcher", keyWin: 1, topWin: 1 }),
      ...span(20, 5, 20),
      // Measured section is clean.
      ...span(200, 40),
    ];
    const report = analyzeFocusSamples(samples, { settleMs: 150 });
    expect(report.warmupCount).toBe(6);
    expect(report.theftFree).toBe(true);
    expect(report.baseline?.pid).toBe(100);
  });

  it("honours an explicit expectation over the observed settle state", () => {
    const samples = span(0, 30, 20, { pid: 50, app: "Launcher" });
    const report = analyzeFocusSamples(samples, {
      settleMs: 100,
      expect: { pid: 100 },
    });
    expect(report.baseline?.pid).toBe(100);
    expect(report.theftFree).toBe(false);
    expect(report.offBaselineSamples).toBe(25);
    expect(report.offBaseline[0]!.changedFields).toEqual(["pid"]);
  });

  it("treats null sample fields as observation gaps, not theft", () => {
    const samples = [
      ...span(0, 20),
      // AX read hiccup: keyWin/focused go null for a few ticks.
      ...span(400, 4, 20, { keyWin: null, keyTitle: null, focusedPid: null, focused: null }),
      ...span(500, 30),
    ];
    const report = analyzeFocusSamples(samples);
    expect(report.theftFree).toBe(true);
    expect(report.uncertainSamples).toBe(4);
  });

  it("skips theft fields whose baseline was never measured", () => {
    const samples = span(0, 30, 20, {
      keyWin: null,
      topWin: null,
      space: null,
      focusedPid: null,
      focused: null,
    });
    samples[20] = { ...samples[20]!, keyWin: 4242 };
    const report = analyzeFocusSamples(samples);
    expect(report.baseline?.keyWin).toBeNull();
    expect(report.baseline?.space).toBeNull();
    expect(report.theftFree).toBe(true);
    expect(report.issues).toContain(
      "key/top window and focused element unmeasured (accessibility grant missing or no windows)",
    );
    expect(report.issues).toContain("active space unmeasured (SkyLight symbol)");
  });

  it("reports focused-element changes as drift, not theft, by default", () => {
    const samples = [
      ...span(0, 20),
      ...span(400, 10, 20, { focused: "100:AXButton:Send" }),
      ...span(600, 20),
    ];
    const report = analyzeFocusSamples(samples);
    expect(report.theftFree).toBe(true);
    expect(report.driftSamples).toBe(2);
    expect(report.drift[0]).toMatchObject({
      index: 20,
      from: "100:AXTextArea:human.txt",
      to: "100:AXButton:Send",
    });
  });

  it("counts focused-element changes as theft under strictFocus", () => {
    const samples = [...span(0, 20), ...span(400, 5, 20, { focused: "100:AXButton:Send" })];
    const report = analyzeFocusSamples(samples, { strictFocus: true });
    expect(report.theftFree).toBe(false);
    expect(report.offBaseline[0]!.changedFields).toContain("focused");
  });

  it("flags insufficient coverage as not-ok", () => {
    const report = analyzeFocusSamples(span(0, 3), { minSamples: 10 });
    expect(report.ok).toBe(false);
    expect(report.theftFree).toBe(true);
    expect(report.issues.some((issue) => issue.includes("thin coverage"))).toBe(true);
  });

  it("reports an empty stream as not-ok with no baseline", () => {
    const report = analyzeFocusSamples([]);
    expect(report.ok).toBe(false);
    expect(report.baseline).toBeNull();
    expect(report.issues).toContain("no post-settle samples");
  });
});

describe("resolveFocusProbePath", () => {
  it("prefers PATHWAY_CUA_FOCUS_PROBE, else the bundled resource", () => {
    expect(resolveFocusProbePath({ PATHWAY_CUA_FOCUS_PROBE: "/dev/probe" }, "/Res")).toBe(
      "/dev/probe",
    );
    expect(resolveFocusProbePath({ PATHWAY_CUA_FOCUS_PROBE: "" }, "/Res")).toBe("/Res/focus-probe");
    expect(resolveFocusProbePath({}, "/Res")).toBe("/Res/focus-probe");
  });
});

const PROBE = "/fixture/Resources/focus-probe";

const withFakeProbe = <A, E>(
  body: (
    fake: Effect.Success<typeof makeFakeHelperSpawner>,
  ) => Effect.Effect<
    A,
    E,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeHelperSpawner;
    return yield* body(fake).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.layer),
      Effect.provide(FileSystem.layerNoop({ exists: (path) => Effect.succeed(path === PROBE) })),
    );
  });

describe("startFocusProbe", () => {
  it.effect("skips without spawning when the sampler is not built", () =>
    withFakeProbe((fake) =>
      Effect.gen(function* () {
        const session = yield* startFocusProbe({ binaryPath: "/missing/focus-probe" });
        expect(Option.isNone(session)).toBe(true);
        expect(fake.spawned).toHaveLength(0);
      }),
    ),
  );

  it.effect("streams samples until stdin EOF and analyzes the run", () =>
    withFakeProbe((fake) =>
      Effect.gen(function* () {
        const session = Option.getOrThrow(
          yield* startFocusProbe({
            binaryPath: PROBE,
            hz: 100,
            label: "semantic-text",
            maxDurationSeconds: 30,
            minSamples: 5,
          }),
        );
        const process = yield* fake.next;
        expect(process.args).toEqual([
          "--stdin",
          "--hz",
          "100",
          "--label",
          "semantic-text",
          "--duration",
          "30",
        ]);
        yield* process.emit({ kind: "meta", pid: process.pid, hz: 100, stdinWatch: true });
        yield* process.emit("not a probe line");
        for (const line of span(0, 6)) yield* process.emit(line);
        yield* process.emit({ kind: "done", samples: 6, stoppedBy: "stdin" });
        yield* process.emitStderr("focus-probe: AX trust missing\n");
        const finishing = yield* Effect.forkChild(session.finish);
        yield* process.exit(0);
        const result = yield* Fiber.join(finishing);
        expect(process.stdinEnded()).toBe(true);
        expect(process.signals).toEqual([]);
        expect(result.exitCode).toBe(0);
        expect(result.meta).toMatchObject({ pid: process.pid, hz: 100, stdinWatch: true });
        expect(result.done).toMatchObject({ samples: 6, stoppedBy: "stdin" });
        expect(result.samples).toHaveLength(6);
        expect(session.samples).toBe(result.samples);
        expect(result.stderr).toBe("focus-probe: AX trust missing\n");
        expect(result.report).toMatchObject({ ok: true, theftFree: true, sampleCount: 6 });
      }),
    ),
  );

  it.effect("signals a sampler that outlives the stdin grace period", () =>
    withFakeProbe((fake) =>
      Effect.gen(function* () {
        const session = Option.getOrThrow(yield* startFocusProbe({ binaryPath: PROBE }));
        const process = yield* fake.next;
        const finishing = yield* Effect.forkChild(session.finish);
        yield* TestClock.adjust(4_999);
        expect(process.signals).toEqual([]);
        yield* TestClock.adjust(1);
        const result = yield* Fiber.join(finishing);
        expect(process.signals).toEqual(["SIGTERM"]);
        expect(result.exitCode).toBeNull();
        expect(result.report.ok).toBe(false);
      }),
    ),
  );

  it.effect("kills an unfinished sampler when its scope closes", () =>
    withFakeProbe((fake) =>
      Effect.gen(function* () {
        yield* Effect.scoped(startFocusProbe({ binaryPath: PROBE }));
        const process = yield* fake.next;
        expect(process.exitedFlag()).toBe(true);
        expect(process.signals).toEqual(["SIGTERM"]);
      }),
    ),
  );
});
