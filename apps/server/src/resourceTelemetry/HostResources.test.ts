import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  darwinAvailableMemory,
  HostResourceReader,
  linuxAvailableMemory,
  make,
} from "./HostResources.ts";

describe("host memory parsing", () => {
  it("uses Linux MemAvailable rather than free or cached memory", () => {
    expect(linuxAvailableMemory("MemFree: 10 kB\nMemAvailable: 123 kB\nCached: 22 kB\n")).toBe(
      123 * 1024,
    );
    expect(linuxAvailableMemory("MemAvailable: 0 kB\n")).toBe(0);
    expect(linuxAvailableMemory("MemFree: 10 kB")).toBeNull();
    expect(linuxAvailableMemory("MemAvailable: 999999999999999999999 kB")).toBeNull();
  });

  it("counts free, inactive, and speculative macOS pages once", () => {
    expect(
      darwinAvailableMemory(
        "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 2.\nPages inactive: 3.\nPages speculative: 4.\nPages purgeable: 3.",
      ),
    ).toBe(9 * 16384);
    expect(darwinAvailableMemory("page size of 4096 bytes\nPages free: 2.")).toBeNull();
    expect(
      darwinAvailableMemory(
        "page size of 0 bytes\nPages free: 2.\nPages inactive: 3.\nPages speculative: 4.",
      ),
    ).toBeNull();
  });
});

describe("HostResources", () => {
  it.effect(
    "shares concurrent samples, caches for five seconds, and samples again after expiry",
    () =>
      Effect.gen(function* () {
        let reads = 0;
        const host = yield* make().pipe(
          Effect.provideService(HostResourceReader, {
            readCpu: () => ({ count: 8, total: ++reads * 100, idle: reads * 75 }),
            totalMemory: () => 1000,
            freeMemory: () => 700,
          }),
        );
        const pending = yield* Effect.all([host.read, host.read], {
          concurrency: "unbounded",
        }).pipe(Effect.forkChild);
        yield* TestClock.adjust("200 millis");
        const samples = yield* Fiber.join(pending);
        expect(reads).toBe(2);
        expect(samples[0]).toEqual(samples[1]);
        expect(samples[0]).toMatchObject({
          cpuUtilization: 0.25,
          cpuCount: 8,
          availableMemoryBytes: 700,
          totalMemoryBytes: 1000,
        });
        yield* TestClock.adjust("4 seconds");
        expect(yield* host.read).toEqual(samples[0]);
        expect(reads).toBe(2);
        yield* TestClock.adjust("2 seconds");
        const refresh = yield* host.read.pipe(Effect.forkChild);
        yield* TestClock.adjust("200 millis");
        expect((yield* Fiber.join(refresh)).sampledAt).toBeGreaterThan(samples[0]!.sampledAt);
        expect(reads).toBe(4);
      }).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provide(NodeServices.layer),
      ),
  );

  it.effect("keeps invalid counters unknown and invalid memory unavailable", () =>
    Effect.gen(function* () {
      let reads = 0;
      const host = yield* make().pipe(
        Effect.provideService(HostResourceReader, {
          readCpu: () => ({ count: 4, total: 100 - ++reads, idle: 50 }),
          totalMemory: () => Number.NaN,
          freeMemory: () => Number.POSITIVE_INFINITY,
        }),
      );
      const pending = yield* host.read.pipe(Effect.forkChild);
      yield* TestClock.adjust("200 millis");
      expect(yield* Fiber.join(pending)).toMatchObject({
        cpuUtilization: null,
        availableMemoryBytes: 0,
        totalMemoryBytes: 0,
      });
    }).pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provide(NodeServices.layer),
    ),
  );
});
