import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { subscribeDeviceForeground } from "./deviceHubApi";

describe("foreground app events", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("clears the last app when it exits and ignores malformed events", () => {
    let listener: ((event: { data: string }) => void) | null = null;
    const source = {
      addEventListener(_type: string, callback: (event: { data: string }) => void) {
        listener = callback;
      },
      close: vi.fn(),
    };
    vi.stubGlobal(
      "EventSource",
      vi.fn(function () {
        return source;
      }),
    );
    const onChange = vi.fn();
    const stop = subscribeDeviceForeground(
      {
        platform: "ios",
        deviceId: "test",
        access: { httpBase: "http://test", wsBase: "ws://test", query: {}, credentials: true },
      },
      onChange,
    );
    const emit = (data: unknown) => listener?.({ data: JSON.stringify(data) });
    emit({ bundleId: "com.example.app", pid: 123 });
    emit({ bundleId: null });
    emit({ bundleId: "com.example.other" });
    emit({ bundleId: "" });
    emit({ other: "not app state" });
    expect(onChange.mock.calls.map(([app]) => app)).toEqual([
      { id: "com.example.app", pid: 123 },
      null,
      { id: "com.example.other" },
      null,
    ]);
    stop();
    expect(source.close).toHaveBeenCalledOnce();
  });
});
