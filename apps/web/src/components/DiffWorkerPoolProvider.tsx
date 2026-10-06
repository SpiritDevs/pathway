import { WorkerPoolContext, useWorkerPool } from "@pierre/diffs/react";
import { WorkerPoolManager, type WorkerRenderingOptions } from "@pierre/diffs/worker";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import * as Schema from "effect/Schema";
import { useEffect, useState, type ReactNode } from "react";
import { useTheme } from "../hooks/useTheme";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";

export class DiffWorkerError extends Schema.TaggedErrorClass<DiffWorkerError>()("DiffWorkerError", {
  operation: Schema.Literals(["create-worker", "get-render-options", "set-render-options"]),
  themeName: Schema.Literals(["pierre-light", "pierre-dark"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Diff worker operation ${this.operation} failed for theme ${this.themeName}.`;
  }
}

function DiffWorkerThemeSync({ themeName }: { themeName: DiffThemeName }) {
  const workerPool = useWorkerPool();

  useEffect(() => {
    if (!workerPool) {
      return;
    }

    let operation: DiffWorkerError["operation"] = "get-render-options";
    void (async () => {
      try {
        const current = workerPool.getDiffRenderOptions();
        if (current.theme === themeName) {
          return;
        }

        operation = "set-render-options";
        await workerPool.setRenderOptions({
          ...current,
          theme: themeName,
        });
      } catch (cause) {
        console.error(new DiffWorkerError({ operation, themeName, cause }));
      }
    })();
  }, [themeName, workerPool]);

  return null;
}

declare global {
  interface Window {
    __pathwayDiffWorkerPool?: WorkerPoolManager;
  }
}

export function getDiffWorkerPool(themeName: DiffThemeName) {
  if (typeof window === "undefined") return undefined;
  if (window.__pathwayDiffWorkerPool) return window.__pathwayDiffWorkerPool;

  let pool: WorkerPoolManager | undefined;
  let renderOptions: WorkerRenderingOptions = {
    theme: themeName,
    tokenizeMaxLineLength: 1_000,
    useTokenTransformer: true,
    lineDiffType: "word-alt",
    maxLineDiffLength: 1_000,
  };
  // Pierre's provider initializes on mount and terminates on last unmount.
  // This window-owned facade only initializes when a renderer asks for work.
  const lazyPool = new Proxy({} as WorkerPoolManager, {
    get(_target, property) {
      if (property === "terminate") return () => {};
      if (property === "getDiffRenderOptions")
        return () => pool?.getDiffRenderOptions() ?? { ...renderOptions };
      if (property === "getFileRenderOptions")
        return () =>
          pool?.getFileRenderOptions() ?? {
            theme: renderOptions.theme,
            tokenizeMaxLineLength: renderOptions.tokenizeMaxLineLength,
            useTokenTransformer: renderOptions.useTokenTransformer,
          };
      if (property === "setRenderOptions")
        return (options: Partial<WorkerRenderingOptions>) => {
          renderOptions = { ...renderOptions, ...options };
          return pool?.setRenderOptions(renderOptions) ?? Promise.resolve();
        };
      if (!pool) {
        const cores = Math.max(1, navigator.hardwareConcurrency || 4);
        pool = new WorkerPoolManager(
          {
            workerFactory: () => {
              try {
                return new DiffsWorker();
              } catch (cause) {
                throw new DiffWorkerError({ operation: "create-worker", themeName, cause });
              }
            },
            poolSize: Math.max(2, Math.min(6, Math.floor(cores / 2))),
            totalASTLRUCacheSize: 240,
          },
          renderOptions,
        );
      }
      const value = Reflect.get(pool, property);
      return typeof value === "function" ? value.bind(pool) : value;
    },
  });
  window.__pathwayDiffWorkerPool = lazyPool;
  return lazyPool;
}

export function DiffWorkerPoolProvider({ children }: { children?: ReactNode }) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const [workerPool] = useState(() => getDiffWorkerPool(diffThemeName));
  return (
    <WorkerPoolContext.Provider value={workerPool}>
      <DiffWorkerThemeSync themeName={diffThemeName} />
      {children}
    </WorkerPoolContext.Provider>
  );
}
