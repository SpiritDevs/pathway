// @effect-diagnostics nodeBuiltinImport:off - the fixture hands the layer a real inherited descriptor.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { types } from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment, HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ComputerApprovalGate from "../ComputerApprovalGate.ts";
import { FakeComputerBackend } from "../FakeComputerBackend.ts";
import { ComputerService, type ComputerServiceShape } from "../Services/ComputerService.ts";
import { UnavailableComputerBackend } from "../UnavailableComputerBackend.ts";
import {
  COMPUTER_HOST_CAPABILITY_ENV,
  COMPUTER_HOST_CAPABILITY_FD_ENV,
  makeComputerServiceLayer,
  resolveHostCapability,
  type ComputerServiceLiveOptions,
} from "./ComputerService.ts";

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

/** The backend the layer chose; a private field, read only to name it in assertions. */
const backendOf = (service: ComputerServiceShape): unknown =>
  (service.manager as unknown as { readonly backend: unknown }).backend;

const CUA_SOCKET = { PATHWAY_CUA_HOST_SOCKET: "/tmp/pathway-cua-test.sock" };

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

  /**
   * The Electron app configures the Cua host socket on every platform, Linux
   * included, so socket presence cannot be what routes a Linux desktop: the
   * Linux tiers decide first, and Cua is what remains when none claims the
   * host. Naming it explicitly reaches it on any platform.
   */
  it.effect("keeps Cua as the Linux fallback", () =>
    Effect.gen(function* () {
      const service = yield* ComputerService;
      expect(service.supported).toBe(true);
      expect(service.availability).not.toMatchObject({ kind: "unsupported-platform" });
      // The Cua host, observing a Linux desktop it does not drive.
      expect(backendOf(service)).not.toBeInstanceOf(UnavailableComputerBackend);
      expect(service.manager.guidanceProfile).toEqual({ dialect: "linux", dedicatedSeat: false });
    }).pipe(Effect.provide(serviceLayer({}).pipe(Layer.provide(onHost("linux", CUA_SOCKET))))),
  );

  it.effect("keeps Cua as the explicit choice on any platform", () =>
    Effect.gen(function* () {
      const service = yield* ComputerService;
      expect(service.supported).toBe(true);
      expect(service.availability).not.toMatchObject({ kind: "unsupported-platform" });
      expect(backendOf(service)).not.toBeInstanceOf(UnavailableComputerBackend);
    }).pipe(
      Effect.provide(
        serviceLayer({}).pipe(
          Layer.provide(onHost("win32", { ...CUA_SOCKET, PATHWAY_COMPUTER_BACKEND: "cua" })),
        ),
      ),
    ),
  );

  it.effect("refuses a Linux host with no tier and no host endpoint rather than faking one", () =>
    Effect.gen(function* () {
      const service = yield* ComputerService;
      expect(service.supported).toBe(false);
      expect(service.availability).toEqual({
        kind: "backend-unavailable",
        message: "No computer backend is available on this server.",
      });
    }).pipe(Effect.provide(serviceLayer({}).pipe(Layer.provide(onHost("linux"))))),
  );

  /**
   * An override is honored or refused, never bypassed. A typo that fell through
   * to auto-detection would boot a different backend and look like the variable
   * does nothing; the unavailable backend carries the reason and the names that
   * do exist instead.
   */
  it.effect("turns a malformed override into an availability card, not another backend", () =>
    Effect.gen(function* () {
      const service = yield* ComputerService;
      expect(service.supported).toBe(false);
      expect(service.availability).toMatchObject({ kind: "backend-unavailable" });
      expect(
        service.availability.kind === "backend-unavailable" ? service.availability.message : "",
      ).toContain('PATHWAY_COMPUTER_BACKEND="protal"');
    }).pipe(
      Effect.provide(
        serviceLayer({}).pipe(
          Layer.provide(onHost("darwin", { PATHWAY_COMPUTER_BACKEND: "protal" })),
        ),
      ),
    ),
  );
});

describe("ComputerServiceLive startup selection", () => {
  it.effect("hands the macOS host its Cua backend directly, probed before startup continues", () =>
    Effect.gen(function* () {
      const service = yield* ComputerService;
      const backend = backendOf(service);
      expect(types.isProxy(backend)).toBe(false);
      expect(backend).not.toBeInstanceOf(UnavailableComputerBackend);
      expect(service.availability.kind).not.toBe("checking");
    }).pipe(Effect.provide(serviceLayer({}).pipe(Layer.provide(onHost("darwin"))))),
  );

  it.effect("starts a Linux host on the slot and never reports a settled pick as checking", () =>
    Effect.gen(function* () {
      const service = yield* ComputerService;
      expect(types.isProxy(backendOf(service))).toBe(true);
      expect(service.availability.kind).not.toBe("checking");
    }).pipe(Effect.provide(serviceLayer({}).pipe(Layer.provide(onHost("linux", CUA_SOCKET))))),
  );
});

describe("resolveHostCapability", () => {
  const secret = "s".repeat(40);

  it.effect("reads an inherited descriptor once, closes it, and clears the variables", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pathway-capability-"));
      const file = NodePath.join(dir, "capability");
      NodeFS.writeFileSync(file, `${secret}\n`);
      const fd = NodeFS.openSync(file, "r");
      const env: NodeJS.ProcessEnv = { [COMPUTER_HOST_CAPABILITY_FD_ENV]: String(fd) };
      try {
        expect(yield* resolveHostCapability(env)).toBe(secret);
        expect(() => NodeFS.fstatSync(fd)).toThrow();
        expect(env).toEqual({});
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("clears a directly given capability too", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { [COMPUTER_HOST_CAPABILITY_ENV]: secret, KEEP: "1" };
      expect(yield* resolveHostCapability(env)).toBe(secret);
      expect(env).toEqual({ KEEP: "1" });
    }),
  );
});
