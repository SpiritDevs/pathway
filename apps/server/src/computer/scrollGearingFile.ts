/**
 * The durable half of scroll gearing: per-app travel-per-pixel ratios that
 * outlive a window.
 *
 * The in-memory `ScrollGearingStore` is the hot path keyed by exact window —
 * the strongest signal, because an inner scroller's gearing belongs to the
 * surface, not the process. But windows churn while toolkits persist: the
 * same Chromium build gears every window it opens the same way, so a window
 * nobody has measured yet can inherit what its app already taught us instead
 * of starting at pixel-true 1 and paying a probe scroll to find out.
 *
 * Nothing here is a security boundary. A corrupt or hand-edited file degrades
 * to no entries — planning then assumes gearing 1, exactly as if the app had
 * never been measured — and never to a failure, because wrong gearing at
 * worst means an off-target scroll, not a refused one.
 *
 * @module computer/scrollGearingFile
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  MAX_SCROLL_GEARING,
  MIN_LEARNABLE_SCROLL_INJECTION,
  MIN_SCROLL_GEARING,
  SCROLL_GEARING_SMOOTHING,
} from "./scrollCalibration.ts";

/** The file's name inside the environment state directory the caller passes in. */
export const SCROLL_GEARING_FILE_NAME = "computer-scroll-gearing.json";
/** How many apps keep a durable gearing before the stalest is forgotten. */
const MAX_APP_ENTRIES = 64;

const AppGearingEntry = Schema.Struct({
  gearing: Schema.Finite.check(
    Schema.isBetween({ minimum: MIN_SCROLL_GEARING, maximum: MAX_SCROLL_GEARING }),
  ),
  samples: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  updatedAt: Schema.Finite,
});
type AppGearingEntry = typeof AppGearingEntry.Type;

/**
 * File envelope. Reading decodes entries one by one, so an unknown version reads
 * as empty and one bad entry drops only itself.
 */
const envelope = <A extends Schema.Top>(entry: A) =>
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.Literal(1), apps: Schema.Record(Schema.String, entry) }),
  );
const decodeEnvelope = Schema.decodeUnknownOption(envelope(Schema.Unknown));
const decodeEntry = Schema.decodeUnknownOption(AppGearingEntry);
const encodeFile = Schema.encodeEffect(envelope(AppGearingEntry));

type PersistEntries = (entries: ReadonlyMap<string, AppGearingEntry>) => Effect.Effect<void>;

export class ScrollGearingFile {
  private readonly apps = new Map<string, AppGearingEntry>();
  private readonly persistEntries: PersistEntries;

  private constructor(persistEntries: PersistEntries) {
    this.persistEntries = persistEntries;
  }

  /**
   * Loads the gearing file from `directory` (the environment's state
   * directory). With no directory the gearing lives in memory only. Missing or
   * corrupt state means "never measured", not "broken", so this never fails.
   */
  static readonly load = Effect.fn("ScrollGearingFile.load")(function* (
    directory: string | undefined,
  ) {
    if (directory === undefined) return new ScrollGearingFile(() => Effect.void);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(directory, SCROLL_GEARING_FILE_NAME);
    const writes = yield* Semaphore.make(1);

    // Atomic rename write, serialized so the newest snapshot always lands last.
    // A started write finishes even when its forked caller is interrupted at
    // shutdown, so it never strands a half-written temporary file. Write
    // failures are swallowed: gearing is an optimization, and a disk error must
    // not fail a scroll.
    const persist = (entries: ReadonlyMap<string, AppGearingEntry>) =>
      writes
        .withPermit(
          Effect.gen(function* () {
            const content = yield* encodeFile({ version: 1, apps: Object.fromEntries(entries) });
            const temporaryPath = `${filePath}.tmp`;
            yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
            yield* fs.writeFileString(temporaryPath, content, { mode: 0o600 });
            yield* fs.rename(temporaryPath, filePath);
          }).pipe(Effect.uninterruptible),
        )
        .pipe(Effect.ignore);

    const file = new ScrollGearingFile(persist);
    const text = yield* fs.readFileString(filePath).pipe(Effect.option);
    const stored = Option.flatMap(text, decodeEnvelope);
    if (Option.isSome(stored) && !Array.isArray(stored.value.apps)) {
      for (const [key, value] of Object.entries(stored.value.apps)) {
        const entry = decodeEntry(value);
        if (Option.isSome(entry)) file.apps.set(key, entry.value);
      }
      while (file.apps.size > MAX_APP_ENTRIES) file.evictStalest();
    }
    return file;
  });

  /** The app's learned ratio, or undefined when it has never been measured. */
  get(appKey: string | undefined): number | undefined {
    return appKey === undefined ? undefined : this.apps.get(appKey)?.gearing;
  }

  /**
   * Folds one accepted window observation into the app's durable entry under
   * the same admissibility rules the hot store applies, then writes the file.
   * Entries are smoothed identically so an app whose toolkit changes converges
   * the same way a window does. Never fails; callers that must not wait on the
   * disk fork it.
   */
  learn(appKey: string | undefined, injected: number, traveled: number): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (appKey === undefined) return Effect.void;
      if (!Number.isFinite(injected) || !Number.isFinite(traveled)) return Effect.void;
      if (traveled === 0 || Math.abs(injected) < MIN_LEARNABLE_SCROLL_INJECTION) {
        return Effect.void;
      }
      if (Math.sign(traveled) !== Math.sign(injected)) return Effect.void;
      const observed = traveled / injected;
      if (observed < MIN_SCROLL_GEARING || observed > MAX_SCROLL_GEARING) return Effect.void;
      return Effect.flatMap(Clock.currentTimeMillis, (now) => {
        const previous = this.apps.get(appKey);
        const next =
          previous === undefined
            ? observed
            : previous.gearing * (1 - SCROLL_GEARING_SMOOTHING) +
              observed * SCROLL_GEARING_SMOOTHING;
        if (previous === undefined && this.apps.size >= MAX_APP_ENTRIES) this.evictStalest();
        this.apps.set(appKey, {
          gearing: Math.min(MAX_SCROLL_GEARING, Math.max(MIN_SCROLL_GEARING, next)),
          samples: (previous?.samples ?? 0) + 1,
          updatedAt: now,
        });
        return this.persistEntries(new Map(this.apps));
      });
    });
  }

  /** The least-recently-updated entry goes first — staleness, not recency of insertion. */
  private evictStalest(): void {
    let stalest: { key: string; updatedAt: number } | undefined;
    for (const [key, entry] of this.apps) {
      if (stalest === undefined || entry.updatedAt < stalest.updatedAt)
        stalest = { key, updatedAt: entry.updatedAt };
    }
    if (stalest !== undefined) this.apps.delete(stalest.key);
  }
}
