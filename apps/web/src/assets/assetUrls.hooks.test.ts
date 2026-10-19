import { EnvironmentId, ThreadId, type AssetCreateUrlResult } from "@spiritdevs/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../test/reactHookHarness";

const state = vi.hoisted(() => ({
  refresh: vi.fn(),
  effects: [] as Array<() => void>,
  queries: new Map<string, object>(),
  connected: true,
  result: undefined as unknown,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: hooks.useRef,
  useCallback: hooks.useCallback,
  useContext: () => ({ refresh: state.refresh }),
  useEffect: (effect: () => void) => {
    state.effects.push(effect);
  },
}));
vi.mock("@effect/atom-react", () => ({ RegistryContext: {}, useAtomValue: () => state.result }));
vi.mock("~/state/session", () => ({
  usePreparedConnection: (environment: string) =>
    state.connected
      ? Option.some({ httpBaseUrl: `https://${environment}.example` })
      : Option.none(),
}));
vi.mock("~/state/environments", () => ({
  useEnvironmentConnectionState: () => ({
    data: { phase: state.connected ? "connected" : "offline" },
  }),
}));
vi.mock("~/state/assets", () => ({
  assetEnvironment: {
    createUrl: (target: unknown) => {
      const key = JSON.stringify(target);
      if (!state.queries.has(key)) state.queries.set(key, {});
      return state.queries.get(key);
    },
  },
}));

import { useAssetUrlState } from "./assetUrls";

function render(environment = "owner") {
  hooks.beginRender();
  const result = useAssetUrlState(EnvironmentId.make(environment), {
    _tag: "workspace-file",
    threadId: ThreadId.make("same-thread"),
    path: "./image.png",
  });
  for (const effect of state.effects.splice(0)) effect();
  return result;
}

beforeEach(() => {
  hooks.reset();
  state.refresh.mockReset();
  state.effects = [];
  state.queries.clear();
  state.connected = true;
  state.result = AsyncResult.success<AssetCreateUrlResult>({
    relativeUrl: "/api/assets/token/image.png",
    expiresAt: Date.now() + 3_600_000,
  });
});

describe("workspace image asset lifecycle", () => {
  it("does not refresh on repeated rendering or streaming and bounds explicit retries", () => {
    for (let index = 0; index < 100; index++) render();
    expect(state.queries.size).toBe(1);
    expect(state.refresh).not.toHaveBeenCalled();
    const first = render();
    first.refresh?.();
    first.refresh?.();
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(render().refresh).toBeUndefined();
  });

  it("refreshes an expired capability once and waits for the existing query", () => {
    state.result = AsyncResult.success<AssetCreateUrlResult>({
      relativeUrl: "/api/assets/expired/image.png",
      expiresAt: 0,
    });
    for (let index = 0; index < 100; index++) expect(render()._tag).toBe("Failure");
    expect(state.refresh).toHaveBeenCalledTimes(1);
    state.result = AsyncResult.success<AssetCreateUrlResult>({
      relativeUrl: "/api/assets/fresh/image.png",
      expiresAt: Date.now() + 3_600_000,
    });
    expect(render()).toMatchObject({
      _tag: "Success",
      url: "https://owner.example/api/assets/fresh/image.png",
    });
  });

  it("keeps asynchronous refreshes scoped to their original resource and environment", () => {
    const old = render();
    expect(render("second")).toMatchObject({
      url: "https://second.example/api/assets/token/image.png",
    });
    old.refresh?.();
    expect(state.refresh).toHaveBeenCalledWith([...state.queries.values()][0]);
    expect(render("second").refresh).toBeTypeOf("function");
    state.connected = false;
    expect(render("second")._tag).toBe("Failure");
    state.connected = true;
    expect(render("second")._tag).toBe("Success");
  });
});
