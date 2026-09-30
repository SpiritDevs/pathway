import { describe, expect, it } from "vite-plus/test";

import { installIndicatorPhaseLock, phaseLockAnimations } from "./indicatorPhaseLock";

function fakeAnimation(animationName: string, startTime: number | null) {
  return { animationName, startTime } as unknown as Animation;
}

function fakeElement(animations: ReadonlyArray<Animation>) {
  return { getAnimations: () => animations };
}

describe("indicator phase lock", () => {
  it("pins every indicator instance to the shared timeline zero", () => {
    const rowA = fakeAnimation("status-pulse", 1_240);
    const rowB = fakeAnimation("status-pulse", 7_815);

    phaseLockAnimations(fakeElement([rowA]), "status-pulse");
    phaseLockAnimations(fakeElement([rowB]), "status-pulse");

    expect(rowA.startTime).toBe(0);
    expect(rowB.startTime).toBe(0);
  });

  it("leaves one-shot and unrelated animations on their own clock", () => {
    const pulse = fakeAnimation("status-pulse", 900);
    const enter = fakeAnimation("pane-enter", 900);
    const spin = fakeAnimation("spin", 900);

    phaseLockAnimations(fakeElement([pulse, enter, spin]), "status-pulse");
    phaseLockAnimations(fakeElement([enter]), "pane-enter");

    expect(pulse.startTime).toBe(0);
    expect(enter.startTime).toBe(900);
    expect(spin.startTime).toBe(900);
  });

  it("locks animations as they start and stops after uninstall", () => {
    let listener: ((event: Event) => void) | null = null;
    const root = {
      addEventListener: (_type: string, callback: EventListenerOrEventListenerObject) => {
        listener = callback as (event: Event) => void;
      },
      removeEventListener: () => {
        listener = null;
      },
    };
    const dot = fakeAnimation("status-ping", 3_000);

    const uninstall = installIndicatorPhaseLock(root);
    listener!({ target: fakeElement([dot]), animationName: "status-ping" } as unknown as Event);
    expect(dot.startTime).toBe(0);

    uninstall();
    expect(listener).toBeNull();
  });
});
