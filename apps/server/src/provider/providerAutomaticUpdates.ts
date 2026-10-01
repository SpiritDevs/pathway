import type { ProviderInstanceId, ServerProvider } from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import {
  ProviderVersionCache,
  enrichProviderSnapshotWithVersionAdvisory,
} from "./providerMaintenance.ts";
import { HttpClient } from "effect/unstable/http";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { ProviderMaintenanceRunner } from "./providerMaintenanceRunner.ts";

export function providerAutomaticUpdateKey(provider: ServerProvider): string | null {
  const advisory = provider.versionAdvisory;
  if (
    !provider.enabled ||
    !provider.installed ||
    advisory?.status !== "behind_latest" ||
    !advisory.canUpdate ||
    !advisory.latestVersion ||
    provider.updateState?.status === "running" ||
    provider.updateState?.status === "queued"
  ) {
    return null;
  }
  // Instances using the same installer/version share one background attempt.
  return JSON.stringify([
    provider.driver,
    advisory.updateCommand,
    advisory.currentVersion,
    advisory.latestVersion,
  ]);
}

export class ProviderAutomaticUpdates extends Context.Service<
  ProviderAutomaticUpdates,
  {
    readonly check: (
      instanceId?: ProviderInstanceId,
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>;
  }
>()("@spiritdevs/pathway/provider/providerAutomaticUpdates") {}

export const make = Effect.gen(function* () {
  const registry = yield* ProviderRegistry;
  const runner = yield* ProviderMaintenanceRunner;
  const settings = yield* ServerSettingsService;
  const scope = yield* Effect.scope;
  const versionCache = yield* ProviderVersionCache;
  const httpClient = yield* HttpClient.HttpClient;
  const enabled = settings.getSettings.pipe(
    Effect.map((settings) => settings.enableProviderUpdateChecks),
    Effect.orElseSucceed(() => false),
  );
  const attempted = new Set<string>();
  const settingsChanges = yield* settings.subscribeChanges;
  let wereUpdatesEnabled = yield* enabled;

  const schedule = Effect.fn("ProviderAutomaticUpdates.schedule")(function* (
    providers: ReadonlyArray<ServerProvider>,
  ) {
    if (!(yield* enabled)) return;
    for (const provider of providers) {
      const key = providerAutomaticUpdateKey(provider);
      if (!key || attempted.has(key)) continue;
      attempted.add(key);
      yield* runner
        .updateProvider(
          { provider: provider.driver, instanceId: provider.instanceId },
          {
            beforeRun: Effect.gen(function* () {
              if (!(yield* enabled)) return false;
              const providers = yield* registry.refreshInstance(provider.instanceId);
              const fresh = providers.find(
                (candidate) => candidate.instanceId === provider.instanceId,
              );
              if (!fresh || !fresh.enabled || !fresh.installed) return false;
              const capabilities = yield* registry.getProviderMaintenanceCapabilitiesForInstance(
                fresh.instanceId,
                fresh.driver,
              );
              const verified = yield* enrichProviderSnapshotWithVersionAdvisory(
                fresh,
                capabilities,
              ).pipe(
                Effect.provideService(HttpClient.HttpClient, httpClient),
                Effect.provideService(ProviderVersionCache, versionCache),
              );
              return (
                verified.versionAdvisory?.status === "behind_latest" &&
                verified.versionAdvisory.canUpdate
              );
            }),
          },
        )
        .pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope));
    }
  });

  // One scheduler and runner per environment, shared by all connected clients.
  yield* forkParked(
    Effect.gen(function* () {
      yield* Stream.runForEach(registry.streamChanges, schedule).pipe(Effect.forkScoped);
      yield* Stream.runForEach(settingsChanges, (next) =>
        Effect.gen(function* () {
          if (!wereUpdatesEnabled && next.enableProviderUpdateChecks) attempted.clear();
          wereUpdatesEnabled = next.enableProviderUpdateChecks;
          if (wereUpdatesEnabled) yield* schedule(yield* registry.getProviders);
        }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* schedule(yield* registry.getProviders);
    }),
  );
  return ProviderAutomaticUpdates.of({
    check: (instanceId) =>
      Effect.gen(function* () {
        versionCache.clear();
        attempted.clear();
        const providers = yield* instanceId === undefined
          ? registry.refresh()
          : registry.refreshInstance(instanceId);
        yield* schedule(providers);
        return providers;
      }),
  });
});

export const layer = Layer.effect(ProviderAutomaticUpdates, make);
