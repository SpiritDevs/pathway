// @effect-diagnostics nodeBuiltinImport:off -- the host points at a driver path that does not exist.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect, vi } from "vite-plus/test";

import { type CuaReply, cuaRequest } from "@spiritdevs/shared/cuaDriverProtocol";
import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";

import { type LinuxCuaDriverHostOptions, makeLinuxCuaDriverHost } from "./LinuxCuaDriverHost.ts";

const capability = "linux-host-test-authority-0000000000000000";

const fixture = Effect.fn("fixture")(function* (
  inputMonitor?: LinuxCuaDriverHostOptions["inputMonitor"],
) {
  const missingRoot = NodePath.join(
    NodeOS.tmpdir(),
    `pathway-no-driver-${NodeCrypto.randomUUID()}`,
  );
  // oxlint-disable-next-line pathway/no-global-process-runtime -- the test's own pid stands in for the app.
  const ownPids = new Set([process.pid]);
  const host = yield* makeLinuxCuaDriverHost({
    binaryPath: NodePath.join(missingRoot, "cua-driver", "cua-driver"),
    bundleId: "test.pathway.linux",
    capability,
    ownPids: () => ownPids,
    ...(inputMonitor ? { inputMonitor } : {}),
  }).pipe(Effect.provideService(HostProcessPlatform, "linux"), Effect.provide(NodeServices.layer));
  yield* Effect.addFinalizer(() => Effect.ignore(host.dispose));
  const endpoint = yield* host.listen;
  const send = (body: Record<string, unknown>) =>
    cuaRequest<CuaReply>(endpoint, { capability, ...body });
  return { endpoint, ownPids, send };
});

describe("Linux desktop host startup", () => {
  it.live(
    "connects task-scoped Escape activation and releases it after the final attributed task",
    () =>
      Effect.gen(function* () {
        let armed = false;
        const activate = vi.fn(() => {
          armed = true;
        });
        const setArmed = vi.fn((value: boolean) => {
          armed = value;
        });
        const f = yield* fixture({
          activate: Effect.sync(activate),
          setArmed: (value) => Effect.sync(() => setArmed(value)),
          state: Effect.sync(() => ({ ready: armed })),
        });
        yield* f.send({ method: "probe" });
        expect(activate).not.toHaveBeenCalled();
        assert.isFalse(armed);
        for (const turnId of ["one", "two"]) {
          // The protected PID refuses before a missing driver could be spawned;
          // the request still exercises the host's attributed task lifecycle.
          expect(
            yield* f.send({
              method: "call",
              name: "browser_prepare",
              // oxlint-disable-next-line pathway/no-global-process-runtime -- the app's own pid.
              args: { pid: process.pid, allow_launch: true },
              task: { threadId: "linux-monitor-fixture", turnId },
            }),
          ).toMatchObject({
            ok: true,
            result: { isError: true, structuredContent: { code: "browser_self_target" } },
          });
        }
        expect(activate).toHaveBeenCalledTimes(2);
        assert.isTrue(armed);
        yield* f.send({
          method: "end_task",
          task: { threadId: "linux-monitor-fixture", turnId: "one" },
        });
        assert.isTrue(armed);
        yield* f.send({
          method: "end_task",
          task: { threadId: "linux-monitor-fixture", turnId: "two" },
        });
        assert.isFalse(armed);
        expect(setArmed).toHaveBeenLastCalledWith(false);
      }),
  );

  it.live("keeps the authenticated host available with an actionable missing-driver response", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(yield* f.send({ method: "probe" })).toMatchObject({
        ok: false,
        error: expect.stringContaining("provisioning"),
      });
      // A missing optional Computer artifact must not reject desktop or server
      // startup or prevent the app from displaying its unavailable state.
      expect(
        yield* cuaRequest<CuaReply>(f.endpoint, {
          method: "probe",
          capability: "not-the-capability",
        }),
      ).toMatchObject({ ok: false });
    }),
  );

  it.live("keeps newly created Pathway helper PIDs protected without starting a driver", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      // oxlint-disable-next-line pathway/no-global-process-runtime -- a pid next to the app's own.
      const helperPid = process.pid + 10_000;
      f.ownPids.add(helperPid);
      expect(
        yield* f.send({
          method: "call",
          name: "browser_prepare",
          args: { pid: helperPid },
          task: { threadId: "linux-host-fixture", turnId: "turn" },
        }),
      ).toMatchObject({
        ok: true,
        result: { isError: true, structuredContent: { code: "browser_self_target" } },
      });
    }),
  );

  it.live("gives Linux session guidance instead of invoking macOS permission helpers", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      expect(yield* f.send({ method: "setup" })).toMatchObject({
        ok: false,
        error: expect.stringContaining("Start Pathway inside your Linux desktop session"),
      });
    }),
  );
});
