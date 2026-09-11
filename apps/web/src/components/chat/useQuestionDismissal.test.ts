import { RuntimeRequestId } from "@spiritdevs/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { useQuestionDismissal } from "./useQuestionDismissal";

const state = vi.hoisted(() => ({
  add: vi.fn(),
  close: vi.fn(),
  effects: [] as Array<() => void>,
  cleanups: new Set<() => void>(),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: state.add, close: state.close } }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
    useRef: reactHookHarness.useRef,
    useCallback: reactHookHarness.useCallback,
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
      const slot = reactHookHarness.useRef<{
        deps?: unknown[];
        cleanup?: (() => void) | undefined;
      }>({});
      if (!slot.current.deps || deps.some((dep, i) => dep !== slot.current.deps?.[i])) {
        state.effects.push(() => {
          slot.current.cleanup?.();
          if (slot.current.cleanup) state.cleanups.delete(slot.current.cleanup);
          slot.current.cleanup = effect() || undefined;
          if (slot.current.cleanup) state.cleanups.add(slot.current.cleanup);
        });
        slot.current.deps = deps;
      }
    },
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
const requestId = RuntimeRequestId.make("question-to-ignore");
const dismiss = vi.fn(async (_id: RuntimeRequestId) => {});
function render(enabled = true, callback = dismiss) {
  hooks.beginRender();
  const result = useQuestionDismissal(callback, enabled);
  state.effects.splice(0).forEach((effect) => effect());
  return result;
}
beforeEach(() => {
  hooks.reset();
  vi.useFakeTimers();
  state.effects = [];
  state.cleanups.clear();
  state.add.mockReset().mockReturnValue("undo-toast");
  state.close.mockReset();
  dismiss.mockClear();
});
afterEach(() => {
  state.cleanups.forEach((cleanup) => cleanup());
  vi.useRealTimers();
});
describe("question dismissal undo window", () => {
  it("waits five seconds and delivers only once", async () => {
    const ui = render();
    ui.scheduleDismissal(requestId);
    ui.scheduleDismissal(requestId);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(dismiss).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(dismiss).toHaveBeenCalledExactlyOnceWith(requestId);
    expect(state.close).toHaveBeenCalledWith("undo-toast");
  });
  it("Undo keeps the question pending and never reaches the provider", async () => {
    render().scheduleDismissal(requestId);
    state.add.mock.calls[0]![0].actionProps.onClick();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dismiss).not.toHaveBeenCalled();
    expect(render().queuedRequestIds).toEqual([]);
  });
  it("cancels unsent dismissals on navigation or capability loss", async () => {
    render().scheduleDismissal(requestId);
    render(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dismiss).not.toHaveBeenCalled();
    render().scheduleDismissal(requestId);
    state.cleanups.forEach((cleanup) => cleanup());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dismiss).not.toHaveBeenCalled();
  });
  it("does not send a queued dismissal after changing conversation", async () => {
    render().scheduleDismissal(requestId);
    const nextConversationDismiss = vi.fn(async (_id: RuntimeRequestId) => {});
    render(true, nextConversationDismiss);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dismiss).not.toHaveBeenCalled();
    expect(nextConversationDismiss).not.toHaveBeenCalled();
  });
  it("does not schedule unsupported cancellation commands", async () => {
    render(false).scheduleDismissal(requestId);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.add).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });
});
