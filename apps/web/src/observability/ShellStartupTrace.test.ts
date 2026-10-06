import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  readiness: "loading",
  shell: {
    hasSnapshot: false,
    hasCachedShell: false,
    hasSynchronizingShell: false,
    hasLiveShell: false,
  },
  effects: [] as (() => void | (() => void))[],
  mark: vi.fn(),
}));
vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void)) => state.effects.push(effect),
}));
vi.mock("../state/threadListReadiness", () => ({ threadListReadinessAtom: "readiness" }));
vi.mock("../state/shell", () => ({ environmentShellSummaryAtom: "shell" }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => (atom === "readiness" ? state.readiness : state.shell),
}));
vi.mock("./clientTracing", () => ({ recordShellStartupMilestone: state.mark }));
import { ShellStartupTrace } from "./ShellStartupTrace";

function mount() {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  ShellStartupTrace();
  const stop = state.effects.pop()!();
  const frame = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  };
  return { frame, stop };
}
afterEach(() => {
  vi.unstubAllGlobals();
  state.mark.mockClear();
  state.readiness = "loading";
  state.shell = {
    hasSnapshot: false,
    hasCachedShell: false,
    hasSynchronizingShell: false,
    hasLiveShell: false,
  };
  state.effects.length = 0;
});
describe("shell paint milestones", () => {
  it("keeps cold or incomplete company/focus bootstrap out of paint measurements", () => {
    state.shell = { ...state.shell, hasSnapshot: true, hasCachedShell: true };
    const app = mount();
    app.frame();
    app.frame();
    expect(state.mark).not.toHaveBeenCalled();
  });
  it("waits for paint and treats mixed live/cached environments as cached", () => {
    state.readiness = "ready";
    state.shell = { ...state.shell, hasSnapshot: true, hasCachedShell: true, hasLiveShell: true };
    const app = mount();
    app.frame();
    expect(state.mark).not.toHaveBeenCalled();
    app.frame();
    expect(state.mark).toHaveBeenCalledWith("cachedShellPainted");
    app.stop?.();
  });
  it("marks live synchronization and cancels a measurement if the shell unmounts before paint", () => {
    state.readiness = "ready";
    state.shell = { ...state.shell, hasSnapshot: true, hasLiveShell: true };
    const cancelled = mount();
    cancelled.frame();
    cancelled.stop?.();
    cancelled.frame();
    expect(state.mark).not.toHaveBeenCalled();
    const live = mount();
    live.frame();
    live.frame();
    expect(state.mark).toHaveBeenCalledWith("liveShellSynced");
  });
});
