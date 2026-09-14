export type AvatarIdle = boolean | "frequent";

/** Prominent avatars stay lively while energy still controls the pauses between gestures. */
export function avatarIdleDelay(energy: number, frequent: boolean, random = Math.random()) {
  return frequent ? 2000 - energy * 6 + random * 900 : 3200 - energy * 10 + random * 2200;
}

export type AvatarGesture = "blink" | "glance" | "greet";

/** Runs brief gestures with real pauses and no active timer while suspended. */
export function createAvatarMotion({
  idle,
  animate,
  idleDelay = () => 2800 + Math.random() * 2400,
  initialDelay = () => 1000 + Math.random() * 1200,
}: {
  idle: boolean;
  animate: (gesture: AvatarGesture) => { cancel: () => void } | undefined;
  idleDelay?: () => number;
  initialDelay?: () => number;
}) {
  let active = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let animation: { cancel: () => void } | undefined;
  function stop() {
    clearTimeout(timer);
    timer = undefined;
    animation?.cancel();
    animation = undefined;
  }
  let idleCount = 0;
  function schedule(initial = false) {
    if (!idle || !active || disposed) return;
    timer = setTimeout(
      () => {
        idleCount += 1;
        react(idleCount % 2 === 0 ? "glance" : "blink");
      },
      initial ? initialDelay() : idleDelay(),
    );
  }
  function react(gesture: AvatarGesture = "greet") {
    if (!active || disposed) return;
    stop();
    animation = animate(gesture);
    schedule();
  }
  return {
    react,
    setActive(next: boolean) {
      if (disposed || next === active) return;
      active = next;
      stop();
      schedule(true);
    },
    dispose() {
      disposed = true;
      active = false;
      stop();
    },
  };
}

type AvatarReactionState = {
  identity: string | undefined;
  expression: string;
  status: string | undefined;
  reactionKey: string | undefined;
};

/** Initial history and switching contacts are presentation, not new conversational events. */
export function shouldReactToAvatarUpdate(
  previous: AvatarReactionState,
  current: AvatarReactionState,
) {
  return (
    previous.identity === current.identity &&
    ((previous.expression !== current.expression &&
      (current.reactionKey === undefined || previous.reactionKey !== undefined)) ||
      (previous.reactionKey !== undefined && previous.reactionKey !== current.reactionKey) ||
      (current.status !== undefined && previous.status !== current.status))
  );
}

/** A bounded morph, retargeted from the currently visible pose on interruption. */
export function createAvatarTransition<T>({
  initial,
  draw,
  mix,
  duration = 420,
  requestFrame = requestAnimationFrame,
  cancelFrame = cancelAnimationFrame,
  now = () => performance.now(),
}: {
  initial: T;
  draw: (value: T) => void;
  mix: (from: T, to: T, progress: number) => T;
  duration?: number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
  now?: () => number;
}) {
  let current = initial;
  let target = initial;
  let frame: number | undefined;
  let active = false;
  let disposed = false;
  function cancel() {
    if (frame !== undefined) cancelFrame(frame);
    frame = undefined;
  }
  function settle() {
    cancel();
    current = target;
    draw(current);
  }
  return {
    update(next: T, immediate = false) {
      if (disposed) return;
      target = next;
      cancel();
      if (!active || immediate) {
        settle();
        return;
      }
      const from = current;
      const start = now();
      function step(time: number) {
        const progress = Math.min(1, Math.max(0, (time - start) / duration));
        current = mix(from, target, 1 - (1 - progress) ** 4);
        draw(current);
        frame = progress < 1 ? requestFrame(step) : undefined;
      }
      frame = requestFrame(step);
    },
    setActive(next: boolean) {
      if (disposed || next === active) return;
      active = next;
      if (!active) settle();
    },
    dispose() {
      disposed = true;
      cancel();
    },
  };
}
