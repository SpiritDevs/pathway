import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { WorkerRenderingOptions } from "@pierre/diffs/worker";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  terminate: vi.fn(),
  highlight: vi.fn(),
  setRenderOptions: vi.fn(),
  theme: "dark",
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: mocks.theme }) }));
vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({ default: vi.fn() }));
vi.mock("@pierre/diffs/worker", () => ({
  WorkerPoolManager: class {
    private renderOptions: WorkerRenderingOptions;
    constructor(options: unknown, renderOptions: WorkerRenderingOptions) {
      this.renderOptions = renderOptions;
      mocks.create(options, renderOptions);
    }
    getDiffRenderOptions() {
      return this.renderOptions;
    }
    async setRenderOptions(options: Partial<WorkerRenderingOptions>) {
      mocks.setRenderOptions(options);
      this.renderOptions = { ...this.renderOptions, ...options };
    }
    highlightFileAST = mocks.highlight;
    terminate = mocks.terminate;
  },
}));

import { DiffWorkerPoolProvider, getDiffWorkerPool } from "./DiffWorkerPoolProvider";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.theme = "dark";
});

it("mounts and changes theme without starting workers, then retains one pool across chat navigation", async () => {
  vi.stubGlobal("window", {});
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(
      <DiffWorkerPoolProvider>
        <span>chat</span>
      </DiffWorkerPoolProvider>,
    );
  });
  expect(mocks.create).not.toHaveBeenCalled();
  const first = getDiffWorkerPool("pierre-dark")!;
  await first.setRenderOptions({ theme: "pierre-light" });
  expect(mocks.create).not.toHaveBeenCalled();
  first.highlightFileAST({} as never, {} as never);
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.create.mock.lastCall![1]).toMatchObject({ theme: "pierre-light" });
  await act(async () => {
    root.unmount();
  });
  expect(mocks.terminate).not.toHaveBeenCalled();
  expect(getDiffWorkerPool("pierre-dark")).toBe(first);
  await act(async () => {
    root = create(
      <DiffWorkerPoolProvider>
        <span>next chat</span>
      </DiffWorkerPoolProvider>,
    );
  });
  expect(mocks.setRenderOptions).toHaveBeenCalledWith(
    expect.objectContaining({ theme: "pierre-dark" }),
  );
  first.highlightFileAST({} as never, {} as never);
  expect(mocks.create).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  first.terminate();
  expect(mocks.terminate).not.toHaveBeenCalled();
});
