// Adapted from t3code #9895 (MIT), https://github.com/pingdotgg/t3code/pull/9895.
import * as NodeOS from "node:os";
import type { HostResourcesSnapshot } from "@spiritdevs/contracts";
import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class HostResources extends Context.Service<
  HostResources,
  { readonly read: Effect.Effect<HostResourcesSnapshot> }
>()("@spiritdevs/pathway/resourceTelemetry/HostResources") {}

function readCpu() {
  const cpus = NodeOS.cpus();
  const cpu = cpus.reduce(
    (sum, { times }) => ({
      idle: sum.idle + times.idle,
      total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq,
    }),
    { idle: 0, total: 0 },
  );
  return { ...cpu, count: cpus.length };
}

/** Host calls are injectable so counter resets and unavailable OS metrics are testable. */
export const HostResourceReader = Context.Reference("@spiritdevs/pathway/HostResourceReader", {
  defaultValue: () => ({ readCpu, totalMemory: NodeOS.totalmem, freeMemory: NodeOS.freemem }),
});

export function darwinAvailableMemory(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1];
  const free = /^Pages free:\s+(\d+)\./m.exec(output)?.[1];
  const inactive = /^Pages inactive:\s+(\d+)\./m.exec(output)?.[1];
  const speculative = /^Pages speculative:\s+(\d+)\./m.exec(output)?.[1];
  if (!pageSize || !free || !inactive || !speculative) return null;
  // vm_stat excludes speculative pages from "Pages free"; purgeable pages overlap.
  const available = (Number(free) + Number(inactive) + Number(speculative)) * Number(pageSize);
  return Number.isSafeInteger(available) && Number(pageSize) > 0 ? available : null;
}

export function linuxAvailableMemory(output: string): number | null {
  const available = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(output)?.[1];
  if (available === undefined) return null;
  const bytes = Number(available) * 1024;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function memoryBytes(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export const make = Effect.fn("makeHostResources")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const host = yield* HostResourceReader;

  const sample = Effect.fn("HostResources.sample")(function* () {
    const previousCpu = host.readCpu();
    // CPU counters need two readings. Idle servers do no polling or process scans.
    yield* Effect.sleep("200 millis");
    const cpu = host.readCpu();
    const totalDelta = cpu.total - previousCpu.total;
    const idleDelta = cpu.idle - previousCpu.idle;
    const cpuUtilization =
      previousCpu.count === cpu.count &&
      Number.isFinite(totalDelta) &&
      totalDelta > 0 &&
      Number.isFinite(idleDelta) &&
      idleDelta >= 0 &&
      idleDelta <= totalDelta
        ? 1 - idleDelta / totalDelta
        : null;
    const totalMemoryBytes = memoryBytes(host.totalMemory());
    // Windows libuv reports available physical memory, including standby memory.
    let availableMemoryBytes = memoryBytes(host.freeMemory());
    if (platform === "linux") {
      const meminfo = yield* fs
        .readFileString("/proc/meminfo")
        .pipe(Effect.orElseSucceed(() => ""));
      availableMemoryBytes = linuxAvailableMemory(meminfo) ?? availableMemoryBytes;
    } else if (platform === "darwin") {
      const output = yield* spawner
        .string(ChildProcess.make("/usr/bin/vm_stat", [], { stdin: "ignore", stderr: "ignore" }))
        .pipe(
          Effect.timeout("1 second"),
          Effect.orElseSucceed(() => ""),
        );
      availableMemoryBytes = darwinAvailableMemory(output) ?? availableMemoryBytes;
    }
    return {
      sampledAt: DateTime.toEpochMillis(yield* DateTime.now),
      cpuUtilization,
      cpuCount: memoryBytes(cpu.count),
      availableMemoryBytes: Math.min(totalMemoryBytes, availableMemoryBytes),
      totalMemoryBytes,
    };
  });

  // One server-lifetime cache shares in-flight samples across all sockets.
  const cache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "host") => sample(),
    timeToLive: "5 seconds",
  });
  return HostResources.of({ read: Cache.get(cache, "host") });
});

export const layer = Layer.effect(HostResources, make());
