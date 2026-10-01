import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { ProviderMaintenanceRunner } from "./providerMaintenanceRunner.ts";
import {
  ProviderVersionCache,
  makeProviderMaintenanceCapabilities,
} from "./providerMaintenance.ts";
import { make, providerAutomaticUpdateKey } from "./providerAutomaticUpdates.ts";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: "1.0.0",
    latestVersion: "2.0.0",
    canUpdate: true,
    updateCommand: "npm install -g @openai/codex@latest",
    checkedAt: "2026-10-01T00:00:00.000Z",
    message: null,
  },
};

const harness = (providers: ReadonlyArray<ServerProvider>, enabled = true) =>
  Effect.gen(function* () {
    const updates = yield* Queue.unbounded<ProviderInstanceId>();
    const completed = yield* Queue.unbounded<boolean>();
    const snapshots = yield* Ref.make(providers);
    const allowUpdates = yield* Ref.make(enabled);
    const settingsChanges = yield* Queue.unbounded<ServerSettings>();
    const verified = yield* Ref.make(0);
    const capabilities = makeProviderMaintenanceCapabilities({
      provider: provider.driver,
      packageName: "@openai/codex",
      updateExecutable: "npm",
      updateArgs: ["install", "-g", "@openai/codex@latest"],
      updateLockKey: "npm-global",
    });
    const cache = new Map();
    const settings = ServerSettingsService.of({
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(allowUpdates).pipe(
        Effect.map((value) => ({ ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: value })),
      ),
      updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.succeed(Stream.fromQueue(settingsChanges)),
    });
    const registry = ProviderRegistry.of({
      getProviders: Ref.get(snapshots),
      refresh: () => Ref.get(snapshots),
      refreshInstance: () => Ref.get(snapshots),
      getProviderMaintenanceCapabilitiesForInstance: () => Effect.succeed(capabilities),
      setProviderMaintenanceActionState: () => Ref.get(snapshots),
      streamChanges: Stream.empty,
    });
    const runner = ProviderMaintenanceRunner.of({
      updateProvider: (target, options) =>
        Effect.gen(function* () {
          yield* Ref.update(verified, (count) => count + 1);
          const shouldRun = !options || (yield* options.beforeRun);
          if (shouldRun) {
            yield* Queue.offer(
              updates,
              typeof target === "string" ? provider.instanceId : target.instanceId!,
            );
          }
          yield* Queue.offer(completed, shouldRun);
          return { providers: yield* Ref.get(snapshots) };
        }),
    });
    const service = yield* make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ServerSettingsService, settings),
          Layer.succeed(ProviderRegistry, registry),
          Layer.succeed(ProviderMaintenanceRunner, runner),
          Layer.succeed(ProviderVersionCache, cache),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(request, Response.json({ version: "2.0.0" })),
              ),
            ),
          ),
        ),
      ),
    );
    return {
      service,
      updates,
      completed,
      snapshots,
      allowUpdates,
      verified,
      cache,
      settingsChanges,
    };
  });

describe("automatic provider updates", () => {
  it("excludes disabled, missing, manual-only and active providers", () => {
    assert.isNotNull(providerAutomaticUpdateKey(provider));
    for (const candidate of [
      { ...provider, enabled: false },
      { ...provider, installed: false },
      { ...provider, versionAdvisory: { ...provider.versionAdvisory!, canUpdate: false } },
      {
        ...provider,
        updateState: {
          status: "queued" as const,
          startedAt: null,
          finishedAt: null,
          message: null,
          output: null,
        },
      },
    ])
      assert.isNull(providerAutomaticUpdateKey(candidate));
  });

  it.effect("updates installed providers on startup without any connected client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness([provider]);
        assert.equal(yield* Queue.take(h.updates), provider.instanceId);
      }),
    ),
  );

  it.effect("coalesces sibling instances and permits retry on an explicit update check", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness([
          provider,
          { ...provider, instanceId: ProviderInstanceId.make("codex_work") },
        ]);
        yield* Queue.take(h.updates);
        assert.equal(yield* Ref.get(h.verified), 1);
        h.cache.set("@openai/codex", { expiresAt: Number.MAX_SAFE_INTEGER, version: "1.0.0" });
        yield* h.service.check();
        yield* Queue.take(h.updates);
        assert.equal(yield* Ref.get(h.verified), 2);
        assert.notEqual(h.cache.get("@openai/codex")?.version, "1.0.0");
      }),
    ),
  );

  it.effect("keeps automatic updates disabled by the existing provider-check setting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness([provider], false);
        yield* h.service.check();
        assert.equal(yield* Ref.get(h.verified), 0);
        yield* Ref.set(h.allowUpdates, true);
        yield* h.service.check();
        assert.equal(yield* Queue.take(h.updates), provider.instanceId);
      }),
    ),
  );

  it.effect("rechecks the installed version before executing an update", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness([{ ...provider, version: "2.0.0" }]);
        yield* h.service.check();
        // The stale advisory was eligible, but the fresh installed version is current.
        assert.isFalse(yield* Queue.take(h.completed));
        assert.equal(yield* Queue.size(h.updates), 0);
      }),
    ),
  );

  it.effect("resumes automatic updates when provider checks are enabled again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness([provider]);
        yield* Queue.take(h.updates);
        yield* Ref.set(h.allowUpdates, false);
        yield* Queue.offer(h.settingsChanges, {
          ...DEFAULT_SERVER_SETTINGS,
          enableProviderUpdateChecks: false,
        });
        yield* Ref.set(h.allowUpdates, true);
        yield* Queue.offer(h.settingsChanges, {
          ...DEFAULT_SERVER_SETTINGS,
          enableProviderUpdateChecks: true,
        });
        assert.equal(yield* Queue.take(h.updates), provider.instanceId);
        assert.equal(yield* Ref.get(h.verified), 2);
      }),
    ),
  );
});
