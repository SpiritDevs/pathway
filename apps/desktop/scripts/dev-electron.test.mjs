import * as NodeEvents from "node:events";
import * as NodePath from "node:path";

import { afterEach, assert, it, vi } from "vite-plus/test";

const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
const existingListeners = new Map(signals.map((signal) => [signal, process.listeners(signal)]));

afterEach(() => {
  for (const signal of signals) {
    for (const listener of process.listeners(signal)) {
      if (!existingListeners.get(signal).includes(listener)) {
        process.removeListener(signal, listener);
      }
    }
  }
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("waits for every preload before launch and restarts when any preload rebuilds", async () => {
  vi.useFakeTimers();
  vi.stubEnv("VITE_DEV_SERVER_URL", "http://localhost:7403");
  const desktopDir = NodePath.resolve("mock-repo/apps/desktop");
  const watchers = new Map();
  const apps = [];
  const spawn = vi.fn(() => {
    const app = new NodeEvents.EventEmitter();
    app.kill = vi.fn(() => app.emit("exit", 0, null));
    apps.push(app);
    return app;
  });
  let reportWait;
  const waiting = new Promise((resolve) => {
    reportWait = resolve;
  });
  let finishBuild;
  const buildComplete = new Promise((resolve) => {
    finishBuild = resolve;
  });
  vi.doMock("node:child_process", () => ({ spawn, spawnSync: vi.fn() }));
  vi.doMock("node:fs", () => ({
    watch: (directory, _options, listener) => {
      watchers.set(directory, listener);
      return { close: vi.fn() };
    },
  }));
  vi.doMock("./electron-launcher.mjs", () => ({
    desktopDir,
    resolveDevProtocolClient: () => undefined,
    resolveElectronLaunchCommand: (args) => ({ electronPath: "/mock/electron", args }),
  }));
  vi.doMock("./wait-for-resources.mjs", () => ({
    waitForResources: (resources) => {
      reportWait(resources);
      return buildComplete;
    },
  }));

  const started = import("./dev-electron.mjs");
  const resources = await waiting;
  const preloads = [
    "preload.cjs",
    "dictation-preload.cjs",
    "mac-permission-preload.cjs",
    "preview-pick-preload.cjs",
    "preview-pip-preload.cjs",
  ];
  for (const preload of preloads) {
    assert.include(resources.files, `dist-electron/${preload}`);
  }
  assert.equal(spawn.mock.calls.length, 0);
  assert.equal(watchers.size, 0);

  finishBuild();
  await started;
  assert.equal(spawn.mock.calls.length, 1);

  const onRebuild = watchers.get(NodePath.join(desktopDir, "dist-electron"));
  onRebuild("change", "dictation-preload.cjs.map");
  await vi.advanceTimersByTimeAsync(120);
  assert.equal(spawn.mock.calls.length, 1);

  for (const [index, preload] of preloads.entries()) {
    onRebuild("change", preload);
    await vi.advanceTimersByTimeAsync(120);
    assert.equal(apps[index].kill.mock.calls.length, 1);
    assert.equal(spawn.mock.calls.length, index + 2);
  }
});
