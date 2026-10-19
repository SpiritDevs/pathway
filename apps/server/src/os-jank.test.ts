import * as NodeOS from "node:os";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment, HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import { WindowsShellEnvironment, CommandAvailability } from "@spiritdevs/shared/shell";

import { fixPath, hydratePosixHome } from "./os-jank.ts";

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
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("hydrates HOME for minimal service environments from the user account", () => {
  const env: NodeJS.ProcessEnv = {};

  hydratePosixHome(env);

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it.effect("repairs missing HOME even when a POSIX desktop already hydrated PATH", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/desktop/bin" };
  return fixPath({ shellEnvironmentHydrated: true }).pipe(
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
