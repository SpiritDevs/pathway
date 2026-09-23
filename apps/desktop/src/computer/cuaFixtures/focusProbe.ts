// @effect-diagnostics nodeBuiltinImport:off -- the fixture resolves a bundle resource path before any Effect runtime exists.
/**
 * Focus-theft probe: runner-side half of the `focus-probe` sampler
 * (Synara's scripts/computer-use-fixtures/focus_probe.m). The binary streams
 * one NDJSON focus sample per tick ({t, pid, app, keyWin, keyTitle, topWin,
 * topTitle, space, focusedPid, focused}); this module parses that stream,
 * picks the baseline, and reports every post-baseline deviation so a fixture
 * or cert run can assert "no theft" instead of eyeballing a log.
 *
 * Theft fields are frontmost pid, key window id, top window id, active Space
 * id and the typing-focus owner pid: the user's frontmost app and key window
 * must not move because of us. The AX focused element changes legitimately
 * when the user tabs inside their own app, so it is reported as `drift`
 * unless strictFocus is set. Null sample fields are observation gaps, not theft.
 */
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Scope from "effect/Scope";

import { type HelperStopError, spawnHelper, stopHelper } from "../HelperProcess.ts";
import { decodeHelperJsonLine } from "../PathwayHelperProtocol.ts";

export interface FocusProbeSample {
  /** Milliseconds since the sampler started. */
  t: number;
  /** Frontmost process id (NSWorkspace.frontmostApplication, SLPS fallback). */
  pid: number | null;
  /** Frontmost application's display name. */
  app: string | null;
  /** AX focused window of the frontmost app as a CGWindowID (needs AX trust). */
  keyWin: number | null;
  keyTitle: string | null;
  /** Topmost normal-layer onscreen window owned by the frontmost process. */
  topWin: number | null;
  topTitle: string | null;
  /** SLSGetActiveSpace for the main display (private SkyLight read). */
  space: number | null;
  /** Owner pid of the system-wide AX focused element. Typing focus can move
   * to another process while frontmostApplication still reads the human's
   * app, so this is a first-class theft field, not just drift. */
  focusedPid: number | null;
  /** "pid:role:title" identity of the system-wide AX focused element. */
  focused: string | null;
}

export interface FocusProbeMeta {
  pid: number;
  hz: number;
  axTrusted: boolean;
  axWindowSymbol: boolean;
  slsSpace: boolean;
  stdinWatch: boolean;
  label: string | null;
  startedAt: number;
}

export interface FocusProbeDone {
  samples: number;
  elapsedMs: number;
  overruns: number;
  stoppedBy: string;
}

export type FocusProbeLine =
  | { kind: "meta"; meta: FocusProbeMeta }
  | { kind: "sample"; sample: FocusProbeSample }
  | { kind: "done"; done: FocusProbeDone };

/** Theft-compared fields. A null baseline or null sample value skips the
 * field, so missing grants narrow coverage instead of fabricating theft. */
export const THEFT_FIELDS = ["pid", "keyWin", "topWin", "space", "focusedPid"] as const;
export type TheftField = (typeof THEFT_FIELDS)[number];
export type ComparedField = TheftField | "focused";

const COMPARED_FIELDS: ReadonlyArray<ComparedField> = [...THEFT_FIELDS, "focused"];

export interface FocusProbeExpect {
  /** Pin the baseline instead of deriving it from the settle window. */
  pid?: number;
  keyWin?: number;
  topWin?: number;
  space?: number;
  focusedPid?: number;
  focused?: string;
}

export interface FocusProbeAnalyzeOptions {
  /** Samples with t < settleMs are warm-up: they seed the baseline and are
   * never counted as violations. */
  settleMs?: number | undefined;
  expect?: FocusProbeExpect | undefined;
  /** Count AX-focused-element changes as theft too. Off by default because a
   * user tabbing inside their own app is indistinguishable from an agent one. */
  strictFocus?: boolean | undefined;
  /** Minimum post-settle samples for `ok`. */
  minSamples?: number | undefined;
}

export interface FocusBaseline {
  pid: number | null;
  keyWin: number | null;
  topWin: number | null;
  space: number | null;
  focusedPid: number | null;
  focused: string | null;
}

export interface FocusObservedState {
  pid: number | null;
  app: string | null;
  keyWin: number | null;
  topWin: number | null;
  space: number | null;
  focusedPid: number | null;
  focused: string | null;
}

export interface FocusViolation {
  /** Index of the first offending sample in the full samples array. */
  index: number;
  tMs: number;
  /** Milliseconds between the first and last offending sample. */
  durationMs: number;
  sampleCount: number;
  /** Fields whose value differed from baseline somewhere in the interval. */
  changedFields: ComparedField[];
  /** Distinct observed states, first-seen order, capped at 8. */
  observed: FocusObservedState[];
}

export interface FocusDrift {
  /** Index of the sample whose focused element differed from the previous. */
  index: number;
  tMs: number;
  from: string;
  to: string;
}

export interface FocusProbeReport {
  /** Enough post-baseline coverage to make the theftFree claim meaningful. */
  ok: boolean;
  /** Zero off-baseline samples on theft fields (plus focused when strict). */
  theftFree: boolean;
  baseline: FocusBaseline | null;
  sampleCount: number;
  warmupCount: number;
  measuredMs: number;
  settleMs: number;
  strictFocus: boolean;
  offBaseline: FocusViolation[];
  offBaselineSamples: number;
  drift: FocusDrift[];
  driftSamples: number;
  /** Post-settle samples where a compared field read null (observation gap). */
  uncertainSamples: number;
  /** Non-null fraction per field across all samples. */
  coverage: Record<ComparedField, number>;
  issues: string[];
}

const optionalNumber = (value: unknown) =>
  Predicate.isNumber(value) && Number.isFinite(value) ? value : null;

const optionalString = (value: unknown) => (Predicate.isString(value) ? value : null);

/** One NDJSON line from focus-probe. Returns null for blank or foreign lines
 * so the parser tolerates a shared stdout. */
export function parseFocusProbeLine(line: string): FocusProbeLine | null {
  const decoded = decodeHelperJsonLine(line);
  if (Option.isNone(decoded)) return null;
  const value = decoded.value;
  if (value.kind === "meta") {
    return {
      kind: "meta",
      meta: {
        pid: optionalNumber(value.pid) ?? -1,
        hz: optionalNumber(value.hz) ?? 0,
        axTrusted: value.axTrusted === true,
        axWindowSymbol: value.axWindowSymbol === true,
        slsSpace: value.slsSpace === true,
        stdinWatch: value.stdinWatch === true,
        label: optionalString(value.label),
        startedAt: optionalNumber(value.startedAt) ?? 0,
      },
    };
  }
  if (value.kind === "done") {
    return {
      kind: "done",
      done: {
        samples: optionalNumber(value.samples) ?? 0,
        elapsedMs: optionalNumber(value.elapsedMs) ?? 0,
        overruns: optionalNumber(value.overruns) ?? 0,
        stoppedBy: optionalString(value.stoppedBy) ?? "unknown",
      },
    };
  }
  if (Predicate.isNumber(value.t)) {
    return {
      kind: "sample",
      sample: {
        t: value.t,
        pid: optionalNumber(value.pid),
        app: optionalString(value.app),
        keyWin: optionalNumber(value.keyWin),
        keyTitle: optionalString(value.keyTitle),
        topWin: optionalNumber(value.topWin),
        topTitle: optionalString(value.topTitle),
        space: optionalNumber(value.space),
        focusedPid: optionalNumber(value.focusedPid),
        focused: optionalString(value.focused),
      },
    };
  }
  return null;
}

/** Most frequent non-null value, ties broken by the latest index. */
function modalValue<T extends number | string>(
  samples: ReadonlyArray<FocusProbeSample>,
  read: (sample: FocusProbeSample) => T | null,
): T | null {
  const counts = new Map<T, { count: number; lastIndex: number }>();
  samples.forEach((sample, index) => {
    const value = read(sample);
    if (value === null) return;
    const entry = counts.get(value);
    if (entry) {
      entry.count += 1;
      entry.lastIndex = index;
    } else counts.set(value, { count: 1, lastIndex: index });
  });
  let best: T | null = null;
  let bestCount = 0;
  let bestLast = -1;
  for (const [value, entry] of counts) {
    if (entry.count > bestCount || (entry.count === bestCount && entry.lastIndex > bestLast)) {
      best = value;
      bestCount = entry.count;
      bestLast = entry.lastIndex;
    }
  }
  return best;
}

/** Per compared field: the pinned expectation, else the modal value across
 * the baseline-source samples. */
const deriveBaseline = (
  samples: ReadonlyArray<FocusProbeSample>,
  expect: FocusProbeExpect | undefined,
): FocusBaseline => ({
  pid: expect?.pid ?? modalValue(samples, (sample) => sample.pid),
  keyWin: expect?.keyWin ?? modalValue(samples, (sample) => sample.keyWin),
  topWin: expect?.topWin ?? modalValue(samples, (sample) => sample.topWin),
  space: expect?.space ?? modalValue(samples, (sample) => sample.space),
  focusedPid: expect?.focusedPid ?? modalValue(samples, (sample) => sample.focusedPid),
  focused: expect?.focused ?? modalValue(samples, (sample) => sample.focused),
});

const sameObserved = (a: FocusObservedState, b: FocusObservedState) =>
  a.pid === b.pid &&
  a.keyWin === b.keyWin &&
  a.topWin === b.topWin &&
  a.space === b.space &&
  a.focusedPid === b.focusedPid &&
  a.focused === b.focused;

const observedOf = (sample: FocusProbeSample): FocusObservedState => ({
  pid: sample.pid,
  app: sample.app,
  keyWin: sample.keyWin,
  topWin: sample.topWin,
  space: sample.space,
  focusedPid: sample.focusedPid,
  focused: sample.focused,
});

export function analyzeFocusSamples(
  allSamples: ReadonlyArray<FocusProbeSample>,
  options: FocusProbeAnalyzeOptions = {},
): FocusProbeReport {
  const settleMs = options.settleMs ?? 0;
  const strictFocus = options.strictFocus === true;
  const minSamples = options.minSamples ?? 10;
  const issues: string[] = [];

  const warmup = allSamples.filter((sample) => sample.t < settleMs);
  const measured = allSamples.filter((sample) => sample.t >= settleMs);

  // Baseline comes from the warm-up window, or the first sample when there
  // was no settle phase at all.
  const baselineSource = warmup.length > 0 ? warmup : allSamples.slice(0, 1);
  const baseline =
    baselineSource.length > 0 ? deriveBaseline(baselineSource, options.expect) : null;

  const compared = strictFocus ? COMPARED_FIELDS : THEFT_FIELDS;
  const coverage = { pid: 0, keyWin: 0, topWin: 0, space: 0, focusedPid: 0, focused: 0 };
  for (const field of COMPARED_FIELDS) {
    const present = allSamples.filter((sample) => sample[field] !== null).length;
    coverage[field] = allSamples.length === 0 ? 0 : present / allSamples.length;
  }
  // A field read on a tick divisor (topWin) or routinely absent is "sparse":
  // its nulls are unsampled ticks, not observation gaps. Only reliably-measured
  // fields (>=50% non-null) make a sample uncertain when they drop out.
  const reliable = (field: ComparedField) => coverage[field] >= 0.5;
  if (
    baseline &&
    baseline.keyWin === null &&
    baseline.topWin === null &&
    baseline.focusedPid === null
  )
    issues.push(
      "key/top window and focused element unmeasured (accessibility grant missing or no windows)",
    );
  if (baseline && baseline.space === null) issues.push("active space unmeasured (SkyLight symbol)");
  if (measured.length === 0) issues.push("no post-settle samples");
  if (measured.length < minSamples)
    issues.push(`thin coverage: ${measured.length} post-settle samples (< ${minSamples})`);

  const offBaseline: FocusViolation[] = [];
  const drift: FocusDrift[] = [];
  let offBaselineSamples = 0;
  let uncertainSamples = 0;
  let openViolation: FocusViolation | null = null;
  let previousFocused: string | null | undefined;
  let driftSamples = 0;

  for (const [measuredIndex, sample] of measured.entries()) {
    const index = warmup.length + measuredIndex;
    const changed = new Set<ComparedField>();
    let uncertain = false;
    if (baseline) {
      for (const field of compared) {
        const expected = baseline[field];
        const actual = sample[field];
        if (expected === null) continue;
        if (actual === null) {
          if (reliable(field)) uncertain = true;
          continue;
        }
        if (actual !== expected) changed.add(field);
      }
    }

    if (changed.size === 0) {
      openViolation = null;
      if (uncertain) uncertainSamples += 1;
      // Drift is a transition record, not a presence record: one entry per
      // focused-element change while the theft fields hold.
      if (!strictFocus && sample.focused !== null) {
        if (
          previousFocused !== undefined &&
          previousFocused !== null &&
          sample.focused !== previousFocused
        ) {
          drift.push({ index, tMs: sample.t, from: previousFocused, to: sample.focused });
          driftSamples += 1;
        }
        previousFocused = sample.focused;
      }
      continue;
    }

    offBaselineSamples += 1;
    const observed = observedOf(sample);
    if (openViolation) {
      openViolation.durationMs = sample.t - openViolation.tMs;
      openViolation.sampleCount += 1;
      for (const field of changed)
        if (!openViolation.changedFields.includes(field)) openViolation.changedFields.push(field);
      if (
        openViolation.observed.length < 8 &&
        !openViolation.observed.some((state) => sameObserved(state, observed))
      )
        openViolation.observed.push(observed);
    } else {
      openViolation = {
        index,
        tMs: sample.t,
        durationMs: 0,
        sampleCount: 1,
        changedFields: [...changed],
        observed: [observed],
      };
      offBaseline.push(openViolation);
    }
  }

  const first = measured[0];
  const last = measured.at(-1);
  const measuredMs = first && last ? last.t - first.t : 0;

  return {
    ok: baseline !== null && measured.length >= minSamples,
    theftFree: offBaseline.length === 0,
    baseline,
    sampleCount: allSamples.length,
    warmupCount: warmup.length,
    measuredMs,
    settleMs,
    strictFocus,
    offBaseline,
    offBaselineSamples,
    drift,
    driftSamples,
    uncertainSamples,
    coverage,
    issues,
  };
}

/** Where a fixture finds the sampler: `PATHWAY_CUA_FOCUS_PROBE` for dev runs,
 * else `focus-probe` in the fixture bundle's resources, where the fixture
 * build places it so the sampler shares the fixture's TCC grants. */
export const resolveFocusProbePath = (
  env: Readonly<Record<string, string | undefined>>,
  resourcesPath: string,
) => env.PATHWAY_CUA_FOCUS_PROBE || NodePath.join(resourcesPath, "focus-probe");

export interface FocusProbeSessionOptions {
  /** The sampler executable; see `resolveFocusProbePath`. */
  readonly binaryPath: string;
  readonly hz?: number | undefined;
  readonly settleMs?: number | undefined;
  readonly expect?: FocusProbeExpect | undefined;
  readonly strictFocus?: boolean | undefined;
  readonly label?: string | undefined;
  readonly minSamples?: number | undefined;
  /** Hard cap for the session; the caller should normally finish it first. */
  readonly maxDurationSeconds?: number | undefined;
}

export interface FocusProbeRunResult {
  readonly report: FocusProbeReport;
  readonly meta: FocusProbeMeta | null;
  readonly done: FocusProbeDone | null;
  readonly samples: ReadonlyArray<FocusProbeSample>;
  readonly stderr: string;
  /** Null when a signal ended the sampler. */
  readonly exitCode: number | null;
}

export interface FocusProbeSession {
  /** Live view of the samples received so far. */
  readonly samples: ReadonlyArray<FocusProbeSample>;
  /** Closes stdin so the sampler stops, waits for its exit, and analyzes the
   * run. A sampler still running after the grace period is stopped. */
  readonly finish: Effect.Effect<FocusProbeRunResult, HelperStopError>;
}

/** How long a sampler gets to stop on stdin EOF before it is signalled. */
const FINISH_GRACE_MS = 5_000;
const STDERR_LIMIT = 16_384;

/**
 * Spawns focus-probe in --stdin mode, attached to the current scope: closing
 * the scope kills a sampler that was never finished. None when the binary is
 * absent, so local runs without a built probe record `skipped` and keep their
 * in-process assertions.
 */
export const startFocusProbe = Effect.fn("desktop.computer.startFocusProbe")(function* (
  options: FocusProbeSessionOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  if (!(yield* fileSystem.exists(options.binaryPath).pipe(Effect.orElseSucceed(() => false))))
    return Option.none<FocusProbeSession>();

  const args = ["--stdin", "--hz", String(options.hz ?? 50), "--label", options.label ?? "fixture"];
  if (options.maxDurationSeconds) args.push("--duration", String(options.maxDurationSeconds));

  const samples: FocusProbeSample[] = [];
  let meta: FocusProbeMeta | null = null;
  let done: FocusProbeDone | null = null;
  const helper = yield* spawnHelper(yield* Scope.Scope, {
    command: options.binaryPath,
    args,
    stdin: true,
    stderrLimit: STDERR_LIMIT,
    onStdoutLine: (line) =>
      Effect.sync(() => {
        const parsed = parseFocusProbeLine(line);
        if (!parsed) return;
        if (parsed.kind === "meta") meta = parsed.meta;
        else if (parsed.kind === "done") done = parsed.done;
        else samples.push(parsed.sample);
      }),
  });

  const finish = Effect.gen(function* () {
    yield* helper.endInput;
    const exit = yield* helper.exited.pipe(
      Effect.timeoutOption(FINISH_GRACE_MS),
      Effect.flatMap(
        Option.match({
          onSome: Effect.succeed,
          onNone: () => stopHelper(helper).pipe(Effect.andThen(helper.exited)),
        }),
      ),
    );
    const result: FocusProbeRunResult = {
      report: analyzeFocusSamples(samples, {
        settleMs: options.settleMs,
        expect: options.expect,
        strictFocus: options.strictFocus,
        minSamples: options.minSamples,
      }),
      meta,
      done,
      samples,
      stderr: yield* helper.stderr,
      exitCode: exit.code,
    };
    return result;
  });

  return Option.some<FocusProbeSession>({ samples, finish });
});
