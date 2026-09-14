import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createAvatarMotion,
  avatarIdleDelay,
  createAvatarTransition,
  shouldReactToAvatarUpdate,
} from "./avatarMotion";
afterEach(() => vi.useRealTimers());

describe("avatar motion lifecycle", () => {
  it("rests between brief blinks, cancels offscreen, and resumes without replay", () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }));
    const motion = createAvatarMotion({
      idle: true,
      animate,
      initialDelay: () => 1200,
      idleDelay: () => 3200,
    });
    expect(vi.getTimerCount()).toBe(0);
    motion.setActive(true);
    expect(animate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1199);
    expect(animate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(animate).toHaveBeenCalledExactlyOnceWith("blink");
    motion.setActive(false);
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60000);
    motion.setActive(true);
    expect(animate).toHaveBeenCalledOnce();
    motion.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("starts visibly, alternates blinks and glances, and rests between gestures", () => {
    vi.useFakeTimers();
    const animate = vi.fn(() => ({ cancel: vi.fn() }));
    const motion = createAvatarMotion({
      idle: true,
      animate,
      initialDelay: () => 1000,
      idleDelay: () => 3000,
    });
    motion.setActive(true);
    vi.advanceTimersByTime(1000);
    expect(animate).toHaveBeenLastCalledWith("blink");
    vi.advanceTimersByTime(2999);
    expect(animate).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(animate).toHaveBeenLastCalledWith("glance");
    vi.advanceTimersByTime(3000);
    expect(animate).toHaveBeenLastCalledWith("blink");
    motion.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("suppresses reactions when reduced motion or document visibility suspends it", () => {
    vi.useFakeTimers();
    const animate = vi.fn(() => ({ cancel: vi.fn() }));
    const motion = createAvatarMotion({ idle: true, animate });
    motion.react();
    expect(animate).not.toHaveBeenCalled();
    motion.setActive(true);
    motion.react();
    motion.setActive(false);
    motion.react();
    expect(animate).toHaveBeenCalledExactlyOnceWith("greet");
    expect(vi.getTimerCount()).toBe(0);
    motion.dispose();
    motion.setActive(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("click reactions replace each other and static history schedules no idle work", () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }));
    const motion = createAvatarMotion({ idle: false, animate });
    motion.setActive(true);
    expect(vi.getTimerCount()).toBe(0);
    motion.react();
    motion.react();
    expect(cancel).toHaveBeenCalledOnce();
    expect(animate).toHaveBeenCalledTimes(2);
    motion.dispose();
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});

describe("avatar event freshness", () => {
  const resting = {
    identity: "chief",
    expression: "neutral",
    status: undefined,
    reactionKey: undefined,
  };
  it("does not replay the expression when initial history arrives", () => {
    const loaded = { ...resting, expression: "pleased", reactionKey: "old-message" };
    expect(shouldReactToAvatarUpdate(resting, loaded)).toBe(false);
    expect(shouldReactToAvatarUpdate(loaded, { ...loaded, reactionKey: "new-message" })).toBe(true);
    expect(shouldReactToAvatarUpdate(loaded, { ...loaded, identity: "other" })).toBe(false);
  });
  it("reacts to actual work changes and explicit preview expression changes", () => {
    expect(shouldReactToAvatarUpdate(resting, { ...resting, status: "working" })).toBe(true);
    expect(shouldReactToAvatarUpdate(resting, { ...resting, expression: "curious" })).toBe(true);
    expect(shouldReactToAvatarUpdate(resting, resting)).toBe(false);
  });
});

describe("avatar expression transitions", () => {
  function setup() {
    let time = 0;
    let id = 0;
    const pending = new Map<number, FrameRequestCallback>();
    const draw = vi.fn();
    const transition = createAvatarTransition({
      initial: 0,
      draw,
      duration: 400,
      mix: (from, to, progress) => from + (to - from) * progress,
      now: () => time,
      requestFrame: (callback) => {
        pending.set(++id, callback);
        return id;
      },
      cancelFrame: (key) => {
        pending.delete(key);
      },
    });
    const frame = (at: number) => {
      time = at;
      const callbacks = [...pending.values()];
      pending.clear();
      callbacks.forEach((callback) => callback(time));
    };
    return { transition, draw, frame, pending };
  }
  it("interpolates in place, retargets from the displayed pose, and stops on arrival", () => {
    const { transition, draw, frame, pending } = setup();
    transition.setActive(true);
    transition.update(100);
    expect(draw).not.toHaveBeenCalled();
    frame(100);
    const midpoint = draw.mock.lastCall![0] as number;
    expect(midpoint).toBeGreaterThan(0);
    expect(midpoint).toBeLessThan(100);
    transition.update(0);
    frame(100);
    expect(draw).toHaveBeenLastCalledWith(midpoint);
    frame(200);
    expect(draw.mock.lastCall![0]).toBeLessThan(midpoint);
    frame(500);
    expect(draw).toHaveBeenLastCalledWith(0);
    expect(pending.size).toBe(0);
  });
  it("settles to the current expression when hidden or reduced motion is enabled", () => {
    const { transition, draw, frame, pending } = setup();
    transition.update(10);
    expect(draw).toHaveBeenLastCalledWith(10);
    expect(pending.size).toBe(0);
    transition.setActive(true);
    transition.update(20);
    frame(100);
    transition.setActive(false);
    expect(draw).toHaveBeenLastCalledWith(20);
    expect(pending.size).toBe(0);
    transition.setActive(true);
    expect(pending.size).toBe(0);
    transition.update(30, true);
    expect(draw).toHaveBeenLastCalledWith(30);
    expect(pending.size).toBe(0);
    transition.update(40);
    transition.dispose();
    expect(pending.size).toBe(0);
    transition.update(50);
    expect(pending.size).toBe(0);
  });
});

describe("prominent avatar cadence", () => {
  it("animates more frequently while retaining the energy preference and pauses", () => {
    expect(avatarIdleDelay(50, true, 0.5)).toBeLessThan(avatarIdleDelay(50, false, 0.5));
    expect(avatarIdleDelay(100, true, 0.5)).toBeLessThan(avatarIdleDelay(0, true, 0.5));
    // Even the most energetic avatar rests after its one-second glance.
    expect(avatarIdleDelay(100, true, 0)).toBeGreaterThan(1000);
  });
  it("keeps scheduling bounded and cancels the faster cadence when hidden", () => {
    vi.useFakeTimers();
    const animate = vi.fn(() => ({ cancel: vi.fn() }));
    const motion = createAvatarMotion({
      idle: true,
      animate,
      initialDelay: () => 600,
      idleDelay: () => avatarIdleDelay(50, true, 0.5),
    });
    motion.setActive(true);
    vi.advanceTimersByTime(10000);
    expect(animate).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(1);
    motion.setActive(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10000);
    expect(animate).toHaveBeenCalledTimes(5);
    motion.dispose();
  });
});
