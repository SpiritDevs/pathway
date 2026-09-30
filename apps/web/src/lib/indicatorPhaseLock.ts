/**
 * Indicator animations (working dots, status pulses, loading ghosts, connection halos) share
 * one clock. A CSS animation's phase starts when its element mounts, so twenty active thread
 * rows would otherwise step their duty-cycled keyframes at twenty different moments and the
 * compositor would draw twenty times as many frames. Pinning every instance to the document
 * timeline's zero makes them step together: the cost of one pulse, however many rows pulse.
 *
 * Staggered siblings keep their offset, because `animation-delay` still applies on top of the
 * shared start time.
 */
export const PHASE_LOCKED_ANIMATION_NAMES: ReadonlySet<string> = new Set([
  "status-pulse",
  "status-ping",
  "status-breathe",
  "status-dim",
  "ghost-pulse",
]);

type PhaseLockEventTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

type AnimatedTarget = { getAnimations: () => ReadonlyArray<Animation> };

function isAnimatedTarget(target: unknown): target is AnimatedTarget {
  return (
    typeof target === "object" &&
    target !== null &&
    typeof (target as Partial<AnimatedTarget>).getAnimations === "function"
  );
}

/** Pins the target's CSS animation named `animationName` to the document timeline's zero. */
export function phaseLockAnimations(target: unknown, animationName: string): void {
  if (!PHASE_LOCKED_ANIMATION_NAMES.has(animationName) || !isAnimatedTarget(target)) return;
  for (const animation of target.getAnimations()) {
    if (
      "animationName" in animation &&
      animation.animationName === animationName &&
      animation.startTime !== 0
    ) {
      animation.startTime = 0;
    }
  }
}

/** Installs the document-wide phase lock once at startup; returns the uninstaller. */
export function installIndicatorPhaseLock(root: PhaseLockEventTarget): () => void {
  const onAnimationStart = (event: Event) => {
    phaseLockAnimations(event.target, (event as AnimationEvent).animationName);
  };
  root.addEventListener("animationstart", onAnimationStart, true);
  return () => root.removeEventListener("animationstart", onAnimationStart, true);
}
