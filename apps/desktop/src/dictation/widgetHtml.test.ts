import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";
import type { DictationCommand, DictationState } from "@spiritdevs/contracts/dictation";
import { createDictationWidgetHtml } from "./widgetHtml.ts";
import { defaultDictationPreferences } from "@spiritdevs/contracts/dictation";
const dictationHistoryFixtures = Array.from({ length: 5 }, (_, index) => ({
  id: `entry-${index}`,
  createdAt: "2026-09-12T09:42:00Z",
  text: `Dictation ${index}`,
  originalText: `Original ${index}`,
  durationMs: 1200,
  modelId: "whisper-turbo" as const,
  language: "en",
  cleanup: "applied" as const,
  delivery: "manual" as const,
}));
function makeDictationFixture(phase: string = "idle"): DictationState {
  return {
    supported: true,
    platform: "darwin",
    authenticated: true,
    accountId: "fixture-account",
    preferences: { ...defaultDictationPreferences("darwin"), setupComplete: true, enabled: true },
    models: [],
    microphones: [],
    microphonePermission: "granted",
    accessibilityPermission: "granted",
    nativeAvailable: true,
    phase:
      phase === "recording-locked"
        ? "recording"
        : phase === "processing"
          ? "processing"
          : phase === "result"
            ? "result"
            : "idle",
    mode: "locked",
    durationMs: 0,
    level: 0,
    result: phase === "result" ? dictationHistoryFixtures[0]! : null,
    error: null,
    dictionaryConnected: true,
    dictionary: [],
  };
}

// A minimal document lets the actual serialized overlay script run without a browser server.
class Element {
  children: Element[] = [];
  attributes = new Map<string, string>();
  events = new Map<string, (() => void)[]>();
  style: Record<string, string> = {};
  className = "";
  textContent = "";
  innerHTML = "";
  id = "";
  replacements = 0;
  readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  append(...elements: Element[]) {
    this.children.push(...elements);
  }
  replaceChildren() {
    this.children = [];
    this.replacements++;
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  addEventListener(event: string, action: () => void) {
    this.events.set(event, [...(this.events.get(event) ?? []), action]);
  }
  trigger(event: string) {
    for (const action of this.events.get(event) ?? []) action();
  }
  all(): Element[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
  querySelector(selector: string) {
    return this.all().find((node) =>
      selector.startsWith(".")
        ? node.className.split(" ").includes(selector.slice(1))
        : node.tag === selector,
    );
  }
  focus() {}
}

async function mount(state: DictationState) {
  const root = new Element("main");
  root.id = "widget";
  let listener!: (state: DictationState) => void;
  const execute = vi.fn(async (_command: DictationCommand) => state);
  let recentReady!: () => void;
  const recentLoaded = new Promise<void>((resolve) => {
    recentReady = resolve;
  });
  const bridge = {
    getState: async () => state,
    execute,
    listHistory: async () => [
      ...dictationHistoryFixtures,
      { ...dictationHistoryFixtures[0]!, id: "sixth" },
    ],
    onState: (next: typeof listener) => {
      listener = next;
      return vi.fn();
    },
    resize: vi.fn((width: number, height: number) => {
      if (width === 408 && height > 190) recentReady();
    }),
  };
  const document = {
    getElementById: (id: string) => root.all().find((node) => node.id === id),
    createElement: (tag: string) => new Element(tag),
    querySelectorAll: (selector: string) =>
      root.all().filter((node) => node.className === selector.slice(1)),
    addEventListener: vi.fn(),
  };
  const script = createDictationWidgetHtml().match(/<script>([\s\S]*)<\/script>/)?.[1];
  if (!script) throw new Error("Overlay script missing");
  NodeVM.runInNewContext(script, {
    window: { dictationOverlay: bridge, addEventListener: vi.fn() },
    document,
  });
  await bridge.getState();
  const click = (label: string) => {
    const button = root.all().find((node) => node.attributes.get("aria-label") === label);
    if (!button) throw new Error(`Missing button: ${label}`);
    button.trigger("click");
  };
  return {
    root,
    recentLoaded,
    bridge,
    click,
    emit: (next: DictationState) => {
      state = next;
      listener(next);
    },
  };
}

describe("dictation overlay", () => {
  it("uses locked recording for the idle Record button and canonical navigation commands", async () => {
    const overlay = await mount(makeDictationFixture());
    overlay.root.trigger("pointerenter");
    overlay.click("Record");
    expect(overlay.bridge.execute).toHaveBeenCalledWith({ type: "start", mode: "locked" });
    overlay.click("Settings");
    expect(overlay.bridge.execute).toHaveBeenCalledWith({ type: "open", page: "settings" });
  });
  it("updates recording indicators without replacing accept/cancel controls", async () => {
    const state = makeDictationFixture("recording-locked");
    const overlay = await mount(state);
    const replacements = overlay.root.replacements;
    for (let frame = 0; frame < 50; frame++)
      overlay.emit({ ...state, durationMs: frame * 1000, level: frame / 50 });
    expect(overlay.root.replacements).toBe(replacements);
    overlay.click("Accept recording");
    expect(overlay.bridge.execute).toHaveBeenCalledWith({ type: "stop" });
    overlay.click("Cancel recording");
    expect(overlay.bridge.execute).toHaveBeenCalledWith({ type: "cancel" });
  });
  it("does not copy a result until the user clicks Copy and renders transcript as text", async () => {
    const state = makeDictationFixture("result");
    const text = '<img src=x onerror="alert(1)">';
    const overlay = await mount({ ...state, result: { ...state.result!, text } });
    expect(overlay.bridge.execute).not.toHaveBeenCalled();
    expect(overlay.root.all().find((node) => node.className === "transcript")?.textContent).toBe(
      text,
    );
    overlay.click("Copy text");
    expect(overlay.bridge.execute).toHaveBeenCalledWith({ type: "copy", text });
  });
  it("limits recent history to five entries and copies their actual text", async () => {
    const overlay = await mount(makeDictationFixture());
    overlay.root.trigger("pointerenter");
    overlay.click("History");
    await overlay.recentLoaded;
    expect(overlay.root.all().filter((node) => node.className === "recent-row")).toHaveLength(5);
    overlay.click("Copy dictation");
    expect(overlay.bridge.execute).toHaveBeenCalledWith({
      type: "copy",
      text: dictationHistoryFixtures[0]!.text,
    });
  });
  it("keeps processing visible with the idle bar hidden and removes account data on sign-out", async () => {
    const state = makeDictationFixture("processing");
    const overlay = await mount({
      ...state,
      preferences: { ...state.preferences, showIdleBar: false },
    });
    expect(overlay.root.all().some((node) => node.textContent === "Transcribing…")).toBe(true);
    overlay.emit({ ...state, authenticated: false });
    expect(overlay.root.children).toHaveLength(0);
  });
});
