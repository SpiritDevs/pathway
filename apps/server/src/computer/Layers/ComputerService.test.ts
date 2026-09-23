import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment, HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ComputerApprovalGate from "../ComputerApprovalGate.ts";
import { FakeComputerBackend } from "../FakeComputerBackend.ts";
import { ComputerService } from "../Services/ComputerService.ts";
import { makeComputerServiceLayer, type ComputerServiceLiveOptions } from "./ComputerService.ts";

/** Builds the service exactly as the server does, minus the state dir. */
const serviceLayer = (options: ComputerServiceLiveOptions) =>
  makeComputerServiceLayer(options).pipe(
    Layer.provide(ComputerApprovalGate.layer),
    Layer.provide(
      Layer.succeed(ComputerApprovalGate.ComputerApprovalRequester, {
        open: () => Effect.void,
        resolve: () => Effect.void,
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

/** Runs on the given host platform and environment instead of this machine's. */
const onHost = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}) =>
  Layer.mergeAll(
    Layer.succeed(HostProcessPlatform, platform),
    Layer.succeed(HostProcessEnvironment, env),
  );

describe("ComputerServiceLive", () => {
  /**
   * The regression this pins is a backend being established by the act of
   * starting the server. Boot decides availability from the passive probe,
   * and seeding a thread's panel — which the web composer does for every
   * ordinary chat — must not upgrade that to the establishing read either.
   */
  it.effect("boots and seeds a thread without ever asking the backend for the desktop", () => {
    const backend = new FakeComputerBackend();
    return Effect.gen(function* () {
      const service = yield* ComputerService;
      expect(service.supported).toBe(true);
      expect(service.availability).toEqual({ kind: "available", backend: "fake" });
      expect(backend.calls.map((call) => call.method)).toEqual(["probeAvailability"]);

      const seeded = yield* service.manager.getThreadState("thread-boot");
      expect(seeded.availability).toEqual({ kind: "available", backend: "fake" });
      expect(seeded.windows).toEqual([]);
      expect(backend.calls.map((call) => call.method)).toEqual([
        "probeAvailability",
        "probeAvailability",
      ]);
    }).pipe(Effect.provide(serviceLayer({ backend })));
  });

  /**
   * Supported means the host could ever drive a desktop, not that it can right
   * now. A backend whose boot probe fails must stay routed through the
   * manager, or the frozen verdict caches "unsupported" until restart and the
   * backend's re-probe can never report the desktop coming up.
   */
  it.effect("stays supported when the boot probe merely reports the backend unavailable", () => {
    const backend = new FakeComputerBackend();
    backend.setAvailability({
      kind: "backend-unavailable",
      message: "The backend is not available yet.",
    });
    return Effect.gen(function* () {
      const service = yield* ComputerService;
      expect(service.supported).toBe(true);
      expect(service.availability).toMatchObject({ kind: "backend-unavailable" });
    }).pipe(Effect.provide(serviceLayer({ backend })));
  });

  it.effect("keeps the configured override ahead of both reads", () => {
    const backend = new FakeComputerBackend();
    return Effect.gen(function* () {
      const service = yield* ComputerService;
      expect(service.supported).toBe(false);
      expect(service.availability).toMatchObject({ kind: "backend-unavailable" });
      // An operator switching the feature off is not a question for the
      // desktop, so neither read runs at all.
      expect(backend.calls).toEqual([]);
    }).pipe(Effect.provide(serviceLayer({ backend, supported: false })));
  });

  /**
   * On Windows there is no backend to build. An agent there must see a refused
   * surface, not a fabricated one, so the platform verdict has to reach the
   * pane's blocked state untouched.
   */
  it.effect("reports an unsupported platform instead of a fake desktop on Windows", () =>
    Effect.gen(function* () {
      const service = yield* ComputerService;
      expect(service.supported).toBe(false);
      expect(service.availability).toEqual({ kind: "unsupported-platform", platform: "win32" });
      const state = yield* service.manager.getThreadState("thread-windows");
      expect(state.availability).toEqual({ kind: "unsupported-platform", platform: "win32" });
    }).pipe(Effect.provide(serviceLayer({}).pipe(Layer.provide(onHost("win32"))))),
  );

  /**
   * Off-darwin the gate is endpoint presence, not platform identity: a
   * configured host socket routes a live backend instead of the
   * unsupported-platform refusal. The probe reports whether it answers.
   */
  it.effect("routes a real backend on Windows when a host endpoint is configured", () =>
    Effect.gen(function* () {
      const service = yield* ComputerService;
      expect(service.supported).toBe(true);
      // The endpoint is unreachable from the test host, so the probe reports
      // the backend unavailable — never unsupported-platform.
      expect(service.availability).not.toMatchObject({ kind: "unsupported-platform" });
    }).pipe(
      Effect.provide(
        serviceLayer({}).pipe(
          Layer.provide(
            onHost("win32", { PATHWAY_CUA_HOST_SOCKET: "\\\\.\\pipe\\pathway-cua-test" }),
          ),
        ),
      ),
    ),
  );

  it.effect("selects the fake backend only when explicitly requested", () =>
    Effect.gen(function* () {
      const service = yield* ComputerService;
      expect(service.supported).toBe(true);
      expect(service.availability).toEqual({ kind: "available", backend: "fake" });
    }).pipe(
      Effect.provide(
        serviceLayer({}).pipe(
          Layer.provide(onHost("darwin", { PATHWAY_COMPUTER_BACKEND: "fake" })),
        ),
      ),
    ),
  );
});
