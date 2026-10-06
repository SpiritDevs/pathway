import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { DesktopShellEnvironmentPatch } from "@spiritdevs/contracts";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";
import { readBootstrapEnvelope } from "./bootstrap.ts";

vi.mock("./bootstrap.ts", () => ({ readBootstrapEnvelope: vi.fn() }));

import * as NodeOS from "node:os";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment, HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import { WindowsShellEnvironment, CommandAvailability } from "@spiritdevs/shared/shell";

import { fixPath, hydratePosixHome, receiveDesktopShellEnvironment } from "./os-jank.ts";

const decodeShellEnvironment = Schema.decodeUnknownEffect(DesktopShellEnvironmentPatch);

it.effect("reuses the desktop environment and still hydrates standalone Windows servers", () =>
  Effect.gen(function* () {
    let probes = 0;
    const env = { PATH: "C:\\inherited" };
    const run = (shellEnvironmentHydrated: boolean) =>
      fixPath({ shellEnvironmentHydrated }).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(HostProcessEnvironment, env),
        Effect.provideService(WindowsShellEnvironment, () => {
          probes += 1;
          return { PATH: "C:\\shell" };
        }),
        Effect.provideService(CommandAvailability, () => Effect.succeed(true)),
      );
    yield* run(true);
    assert.equal(probes, 0);
    assert.equal(env.PATH, "C:\\inherited");
    yield* run(false);
    assert.equal(probes, 1);
    assert.include(env.PATH, "C:\\shell");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("hydrates HOME for minimal service environments from the user account", () => {
  const env: NodeJS.ProcessEnv = {};

  hydratePosixHome(env);

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it.effect("repairs missing HOME even when a POSIX desktop already hydrated PATH", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/desktop/bin" };
  return fixPath({ shellEnvironmentHydrated: true }).pipe(
    Effect.scoped,
    Effect.provideService(HostProcessPlatform, "darwin"),
    Effect.provideService(HostProcessEnvironment, env),
    Effect.provide(NodeServices.layer),
    Effect.tap(() =>
      Effect.sync(() => {
        assert.equal(env.HOME, NodeOS.userInfo().homedir);
        assert.equal(env.PATH, "/desktop/bin");
      }),
    ),
  );
});

it("hydrates HOME independently of a blank process HOME", () => {
  const originalHome = process.env.HOME;
  const env: NodeJS.ProcessEnv = { HOME: " " };

  try {
    process.env.HOME = " ";
    hydratePosixHome(env);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("preserves an explicitly configured HOME", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };

  hydratePosixHome(env, () => {
    throw new Error("HOME lookup should not run");
  });

  assert.equal(env.HOME, "/custom/home");
});

it.effect("gates first-launch services on the fresh desktop handoff", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    vi.mocked(readBootstrapEnvelope).mockReturnValue(
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as(Option.some({ PATH: "/fresh/bin", LC_CTYPE: "en_US.UTF-8" })),
      ),
    );
    const env: NodeJS.ProcessEnv = { PATH: "/inherited/bin", HOME: "/home/test" };
    const ready = yield* Deferred.make<void>();
    const boot = yield* fixPath({ shellEnvironmentFd: 6, shellEnvironmentHydrated: false }).pipe(
      Effect.andThen(Deferred.succeed(ready, undefined)),
      Effect.forkScoped,
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provideService(HostProcessEnvironment, env),
    );
    yield* Deferred.await(started);
    assert.isFalse(yield* Deferred.isDone(ready));
    assert.equal(env.PATH, "/inherited/bin");
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(boot);
    assert.equal(env.PATH, "/fresh/bin");
    assert.equal(env.LC_CTYPE, "en_US.UTF-8");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("uses a validated desktop cache without blocking on the background handoff", () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    vi.mocked(readBootstrapEnvelope).mockReturnValue(
      Deferred.await(release).pipe(Effect.as(Option.some({ PATH: "/fresh/bin" }))),
    );
    const env: NodeJS.ProcessEnv = { PATH: "/cached/bin", HOME: "/home/test" };
    yield* fixPath({ shellEnvironmentFd: 6, shellEnvironmentHydrated: true }).pipe(
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provideService(HostProcessEnvironment, env),
    );
    assert.equal(env.PATH, "/cached/bin");
    yield* Deferred.succeed(release, undefined);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("replaces shell values while retaining backend-only environment variables", () =>
  Effect.gen(function* () {
    const patch = yield* decodeShellEnvironment({
      PATH: "/fresh/bin",
      PATHWAY_HOME: "/unexpected",
      NODE_OPTIONS: "unexpected",
    });
    vi.mocked(readBootstrapEnvelope).mockReturnValue(Effect.succeedSome(patch));
    const env: NodeJS.ProcessEnv = {
      PATH: "/cached/bin",
      HOMEBREW_PREFIX: "/removed",
      PATHWAY_HOME: "/backend/home",
    };
    assert.isTrue(
      yield* receiveDesktopShellEnvironment(6).pipe(
        Effect.provideService(HostProcessEnvironment, env),
      ),
    );
    assert.equal(env.PATH, "/fresh/bin");
    assert.isUndefined(env.HOMEBREW_PREFIX);
    assert.equal(env.PATHWAY_HOME, "/backend/home");
    assert.isUndefined(env.NODE_OPTIONS);
  }),
);
