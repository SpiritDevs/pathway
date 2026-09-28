// @effect-diagnostics nodeBuiltinImport:off - Runs the injected bridge without launching a browser.
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";
import { remoteBrowserBridge, selectResponseScript } from "./remoteBrowserBridge.ts";
class Element {
  isConnected = true;
}
class Group {
  disabled = false;
}
class Select extends Element {
  disabled = false;
  multiple = false;
  size = 1;
  focus = vi.fn();
  dispatchEvent = vi.fn();
  options = [0, 1].map((index) => ({
    index,
    value: String(index),
    label: `Option ${index}`,
    disabled: false,
    selected: index === 0,
    parentElement: new Group(),
  }));
}
describe("browser document bridge", () => {
  it("intercepts a watched native select, chooses by index and dispatches input/change", async () => {
    const events = new Map<string, (event: unknown) => void>();
    const messages: unknown[] = [];
    const context = {
      Element,
      HTMLSelectElement: Select,
      HTMLOptGroupElement: Group,
      Event: class {
        readonly type: string;
        constructor(type: string) {
          this.type = type;
        }
      },
      document: {
        addEventListener: (name: string, listener: (event: unknown) => void) =>
          events.set(name, listener),
      },
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      crypto: { randomUUID: () => "id" },
      __pathwayBrowserEvent: async (value: unknown) => {
        messages.push(value);
        return true;
      },
      __pathwayBrowserWatching: false,
    };
    NodeVM.runInNewContext(remoteBrowserBridge, context);
    await Promise.resolve();
    const select = new Select();
    const preventDefault = vi.fn();
    const event = { type: "pointerdown", composedPath: () => [select], preventDefault };
    events.get("pointerdown")!(event);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(messages.at(-1)).toMatchObject({
      type: "select",
      selectId: "id",
      options: [
        { index: 0, selected: true },
        { index: 1, selected: false },
      ],
    });
    NodeVM.runInNewContext(selectResponseScript("id", [1]), context);
    expect(select.options.map((o) => o.selected)).toEqual([false, true]);
    expect(select.dispatchEvent.mock.calls.map((args) => args[0].type)).toEqual([
      "input",
      "change",
    ]);
    expect(() => NodeVM.runInNewContext(selectResponseScript("id", [0]), context)).toThrow(
      "no longer",
    );
    context.__pathwayBrowserWatching = false;
    preventDefault.mockClear();
    events.get("pointerdown")!(event);
    expect(preventDefault).not.toHaveBeenCalled();
  });
  it("rejects disabled options and supports cancellation without changing selection", () => {
    const select = new Select();
    select.options[1]!.parentElement.disabled = true;
    const context = {
      __pathwayRemoteSelect: { id: "popup", element: select },
      HTMLOptGroupElement: Group,
    };
    expect(() => NodeVM.runInNewContext(selectResponseScript("popup", [1]), context)).toThrow(
      "unavailable",
    );
    NodeVM.runInNewContext(selectResponseScript("popup", null), context);
    expect(select.options[0]!.selected).toBe(true);
    expect(select.dispatchEvent).not.toHaveBeenCalled();
  });
});
