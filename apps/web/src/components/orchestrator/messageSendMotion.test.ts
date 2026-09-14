import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { animateSentMessage, messageFlightTransform } from "./messageSendMotion";

const origin = { left: 100, top: 700, width: 400, height: 40 };
const destination = { left: 400, top: 600, width: 200, height: 50 };
afterEach(() => vi.unstubAllGlobals());

function setup() {
  let finish!: () => void;
  const animation = {
    finished: new Promise<void>((resolve) => {
      finish = resolve;
    }),
    cancel: vi.fn(),
  };
  const createElement = () => ({
    style: {} as Record<string, string>,
    dataset: {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setAttribute: vi.fn(),
    append: vi.fn(),
    remove: vi.fn(),
  });
  const layer = createElement();
  const clone = { ...createElement(), removeAttribute: vi.fn(), animate: vi.fn(() => animation) };
  const surface = { append: vi.fn(), getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const bubble = {
    style: { opacity: "" },
    cloneNode: () => clone,
    getBoundingClientRect: () => destination,
  };
  const scroller = Object.assign(new EventTarget(), {
    closest: () => surface,
    clientHeight: 600,
    scrollTop: 200,
  });
  const media = Object.assign(new EventTarget(), { matches: false });
  const win = Object.assign(new EventTarget(), { matchMedia: () => media });
  const doc = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    createElement: () => layer,
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("getComputedStyle", () => ({ font: "14px sans-serif" }));
  const start = () =>
    animateSentMessage(
      bubble as unknown as HTMLElement,
      scroller as unknown as HTMLElement,
      origin,
    );
  return { start, finish, animation, bubble, scroller, surface, layer, clone, media, win, doc };
}

describe("sent message motion", () => {
  it("starts at the input text position and travels to the outgoing bubble", () => {
    expect(messageFlightTransform(origin, destination)).toBe("translate(-300px, 95px) scale(0.96)");
  });
  it("restores the real message and removes the temporary layer on completion", async () => {
    const s = setup();
    s.start();
    expect(s.bubble.style.opacity).toBe("0");
    expect(s.layer.setAttribute).toHaveBeenCalledWith("aria-hidden", "true");
    expect(s.clone.removeAttribute).toHaveBeenCalledWith("data-message-id");
    s.finish();
    await s.animation.finished;
    expect(s.bubble.style.opacity).toBe("");
    expect(s.layer.remove).toHaveBeenCalledOnce();
    expect(s.animation.cancel).toHaveBeenCalledOnce();
  });
  it.each(["resize", "scroll", "motion", "unmount"])(
    "restores the bubble if %s interrupts the flight",
    (reason) => {
      const s = setup();
      const cleanup = s.start();
      if (reason === "resize") s.win.dispatchEvent(new Event("resize"));
      if (reason === "scroll") {
        s.scroller.scrollTop += 10;
        s.scroller.dispatchEvent(new Event("scroll"));
      }
      if (reason === "motion") s.media.dispatchEvent(new Event("change"));
      if (reason === "unmount") cleanup?.();
      cleanup?.();
      expect(s.bubble.style.opacity).toBe("");
      expect(s.layer.remove).toHaveBeenCalledOnce();
    },
  );
  it("ignores the scroll event from positioning the newly sent message", () => {
    const s = setup();
    const cleanup = s.start();
    s.scroller.dispatchEvent(new Event("scroll"));
    expect(s.layer.remove).not.toHaveBeenCalled();
    cleanup?.();
  });
  it.each(["reduced motion", "hidden document", "long message"])(
    "keeps the bubble visible without a flight for %s",
    (reason) => {
      const s = setup();
      if (reason === "reduced motion") s.media.matches = true;
      if (reason === "hidden document") s.doc.visibilityState = "hidden";
      if (reason === "long message") s.scroller.clientHeight = 30;
      expect(s.start()).toBeUndefined();
      expect(s.bubble.style.opacity).toBe("");
      expect(s.surface.append).not.toHaveBeenCalled();
    },
  );
});
