import {
  createAvatarMotion,
  createAvatarTransition,
  shouldReactToAvatarUpdate,
} from "./avatarMotion";
import {
  avatarPose,
  avatarPath,
  avatarPoseTransform,
  avatarGazeTransform,
  mixAvatarPose,
  type AvatarPose,
} from "./avatarPose";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { cn } from "../../lib/utils";
import type {
  AiOrchestrator,
  OrchestratorActivity,
  OrchestratorMessage,
  OrchestratorWorkItem,
} from "@spiritdevs/contracts/aiOrchestrator";
import {
  DEFAULT_AVATAR,
  normalizeAvatarExpression,
  resolvePersonality,
  type AvatarExpression,
} from "@spiritdevs/contracts/orchestratorAvatar";

export const ORCHESTRATOR_COLORS = {
  violet: "bg-violet-500",
  blue: "bg-blue-500",
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  pink: "bg-pink-500",
  cyan: "bg-cyan-600",
};
const INKS: Record<string, string> = {
  violet: "var(--color-violet-500)",
  blue: "var(--color-blue-500)",
  green: "var(--color-emerald-500)",
  amber: "var(--color-amber-500)",
  pink: "var(--color-pink-500)",
  cyan: "var(--color-cyan-600)",
};
export type AvatarContact = Pick<AiOrchestrator, "name" | "color"> &
  Partial<Pick<AiOrchestrator, "id" | "avatar" | "personality" | "status">> & {
    activityExpiresAt?: number;
    workStatus?: AvatarWorkStatus;
  };
export type AvatarWorkStatus = "working" | "queued" | "blocked" | "completed" | "paused";
const STATUS_LABELS: Record<AvatarWorkStatus, string> = {
  working: "Working",
  queued: "Queued",
  blocked: "Needs attention",
  completed: "Completed",
  paused: "Paused",
};
const STATUS_COLORS: Record<AvatarWorkStatus, string> = {
  working: "bg-blue-500",
  queued: "bg-amber-500",
  blocked: "bg-red-500",
  completed: "bg-emerald-500",
  paused: "bg-muted-foreground",
};

/** Work status is independent of a response's conversational expression. */
export function avatarWorkStatus(
  contact: AvatarContact | undefined,
  work: readonly OrchestratorWorkItem[] = [],
  activity: OrchestratorActivity = [],
): AvatarWorkStatus | undefined {
  if (contact?.status === "paused") return "paused";
  if (!contact?.id) return undefined;
  if (activity.some((item) => item.id === contact.id && item.expiresAt > Date.now()))
    return "working";
  const items = work.filter((item) => item.orchestratorId === contact.id);
  if (items.some((item) => item.status === "working")) return "working";
  if (items.some((item) => item.status === "queued")) return "queued";
  const latest = items.toSorted(
    (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0),
  )[0];
  if (latest?.status === "failed" || latest?.status === "unknown") return "blocked";
  if (latest?.status === "completed") return "completed";
  return undefined;
}

export function OrchestratorAvatar({
  contact,
  className,
  expression = "neutral",
  status: requestedStatus,
  idle = false,
  interactive = false,
  reactionKey,
}: {
  contact?: AvatarContact | undefined;
  className?: string | undefined;
  expression?: AvatarExpression | undefined;
  status?: AvatarWorkStatus | undefined;
  idle?: boolean;
  interactive?: boolean;
  reactionKey?: string | undefined;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const body = useRef<HTMLSpanElement>(null);
  const eyes = useRef<SVGGElement>(null);
  const gaze = useRef<SVGGElement>(null);
  const posedBody = useRef<SVGGElement>(null);
  const posedFace = useRef<SVGGElement>(null);
  const silhouette = useRef<SVGPathElement>(null);
  const leftEye = useRef<SVGPathElement>(null);
  const rightEye = useRef<SVGPathElement>(null);
  const motionRef = useRef<ReturnType<typeof createAvatarMotion> | null>(null);
  const transitionRef = useRef<ReturnType<typeof createAvatarTransition<AvatarPose>> | null>(null);
  const [activityTime, setActivityTime] = useState(() => Date.now());
  const activityExpiresAt = contact?.activityExpiresAt ?? 0;
  useEffect(() => {
    const remaining = activityExpiresAt - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setActivityTime(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [activityExpiresAt]);
  const status =
    requestedStatus ??
    (contact?.status === "paused"
      ? "paused"
      : activityExpiresAt > Math.max(activityTime, Date.now())
        ? "working"
        : contact?.workStatus);
  const previous = useRef({ identity: contact?.id, expression, status, reactionKey });
  const traits = useMemo(
    () => resolvePersonality(contact?.personality, "avatar"),
    [contact?.personality],
  );
  const appearance = contact?.avatar ?? DEFAULT_AVATAR;
  const mood = normalizeAvatarExpression(expression);
  const [initialPose] = useState(() => avatarPose(appearance, mood, traits));
  const displayedPose = useRef(initialPose);
  const motionTraits = useRef(traits);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    let glanceCount = 0;
    const transition = createAvatarTransition({
      initial: displayedPose.current,
      mix: mixAvatarPose,
      draw: (pose) => {
        displayedPose.current = pose;
        silhouette.current?.setAttribute("d", avatarPath(pose.body));
        leftEye.current?.setAttribute("d", avatarPath(pose.left));
        rightEye.current?.setAttribute("d", avatarPath(pose.right));
        posedBody.current?.setAttribute("transform", avatarPoseTransform(pose));
        posedFace.current?.setAttribute("transform", avatarGazeTransform(pose));
      },
    });
    const motion = createAvatarMotion({
      idle,
      idleDelay: () => 3200 - motionTraits.current.energy * 10 + Math.random() * 2200,
      animate: (gesture) => {
        const traits = motionTraits.current;
        const strength = 0.4 + traits.expressiveness / 120;
        const animations: Animation[] = [];
        const play = (target: Element | null, frames: Keyframe[], duration: number) => {
          if (target?.animate)
            animations.push(
              target.animate(frames, {
                duration,
                easing: "cubic-bezier(0.25, 1, 0.5, 1)",
              }),
            );
        };
        play(
          eyes.current,
          [
            { transform: "scaleY(1)" },
            { transform: "scaleY(0.08)", offset: 0.35 },
            { transform: "scaleY(0.08)", offset: 0.5 },
            { transform: "scaleY(1)" },
          ],
          gesture === "greet" ? 280 : 210,
        );
        if (gesture !== "blink") {
          const greeting = gesture === "greet";
          const direction = greeting ? 1 : ++glanceCount % 2 === 0 ? -1 : 1;
          const look = direction * (greeting ? 3 : 3 + traits.curiosity / 25);
          play(
            gaze.current,
            [
              { transform: "translate(0px, 0px)" },
              { transform: `translate(${look}px, -2px)`, offset: 0.3 },
              { transform: `translate(${look}px, -2px)`, offset: 0.7 },
              { transform: "translate(0px, 0px)" },
            ],
            greeting ? 480 : 1600,
          );
          const turn = direction * (greeting ? 4 + traits.playfulness / 18 : 1.5) * strength;
          play(
            body.current,
            [
              { transform: "translateY(0%) rotate(0deg) scale(1, 1)" },
              {
                transform: `translateY(${greeting ? -3 : -0.5}%) rotate(${turn}deg) scale(${1 + (greeting ? 0.09 : 0.015) * strength}, ${1 - (greeting ? 0.055 : 0.01) * strength})`,
                offset: 0.35,
              },
              { transform: "translateY(0%) rotate(0deg) scale(1, 1)" },
            ],
            greeting ? 480 : 1600,
          );
        }
        return { cancel: () => animations.forEach((animation) => animation.cancel()) };
      },
    });
    motionRef.current = motion;
    transitionRef.current = transition;
    const refresh = () => {
      const active = visible && !document.hidden && !reduced.matches;
      motion.setActive(active);
      transition.setActive(active);
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      refresh();
    });
    observer.observe(element);
    const button = element.closest("button");
    const onClick = () => motion.react();
    button?.addEventListener("click", onClick);
    document.addEventListener("visibilitychange", refresh);
    reduced.addEventListener("change", refresh);
    return () => {
      motion.dispose();
      transition.dispose();
      motionRef.current = null;
      transitionRef.current = null;
      observer.disconnect();
      button?.removeEventListener("click", onClick);
      document.removeEventListener("visibilitychange", refresh);
      reduced.removeEventListener("change", refresh);
    };
  }, [idle]);

  useEffect(() => {
    motionTraits.current = traits;
    const previousValue = previous.current;
    const current = { identity: contact?.id, expression, status, reactionKey };
    previous.current = current;
    transitionRef.current?.update(
      avatarPose({ shape: appearance.shape, eyes: appearance.eyes }, mood, traits),
      previousValue.identity !== current.identity,
    );
    if (shouldReactToAvatarUpdate(previousValue, current)) motionRef.current?.react();
  }, [
    contact?.id,
    expression,
    status,
    reactionKey,
    appearance.shape,
    appearance.eyes,
    mood,
    traits,
  ]);

  const face = (
    <span
      ref={root}
      data-orchestrator-avatar=""
      className={cn("relative inline-flex size-10 shrink-0 items-center justify-center", className)}
    >
      <span
        ref={body}
        aria-hidden="true"
        className="inline-flex size-full"
        style={{ color: INKS[contact?.color ?? "violet"] ?? INKS.violet } as CSSProperties}
      >
        <svg viewBox="0 0 100 100" className="size-full overflow-visible text-inherit" fill="none">
          <g ref={posedBody} transform={avatarPoseTransform(initialPose)}>
            <path ref={silhouette} d={avatarPath(initialPose.body)} fill="currentColor" />
            <g ref={posedFace} transform={avatarGazeTransform(initialPose)}>
              <g ref={gaze}>
                <g
                  ref={eyes}
                  style={{ transformBox: "view-box", transformOrigin: "50px 48px" }}
                  fill="var(--color-white)"
                >
                  <path ref={leftEye} d={avatarPath(initialPose.left)} />
                  <path ref={rightEye} d={avatarPath(initialPose.right)} />
                </g>
              </g>
            </g>
          </g>
        </svg>
      </span>
      {status && (
        <span
          role="img"
          aria-label={STATUS_LABELS[status]}
          title={STATUS_LABELS[status]}
          className={cn(
            "absolute right-0 bottom-0 size-2.5 rounded-full ring-2 ring-popover",
            STATUS_COLORS[status],
          )}
        />
      )}
    </span>
  );
  return interactive ? (
    <button
      type="button"
      aria-label={`Greet ${contact?.name ?? "your orchestrator"}`}
      className="inline-flex shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {face}
    </button>
  ) : (
    face
  );
}

const EMPTY_MESSAGES: readonly OrchestratorMessage[] = [];
const EMPTY_WORK: readonly OrchestratorWorkItem[] = [];
const EMPTY_ACTIVITY: OrchestratorActivity = [];

export function ConversationAvatar({
  contacts,
  className,
  messages = EMPTY_MESSAGES,
  work = EMPTY_WORK,
  activity = EMPTY_ACTIVITY,
  idle = false,
  fallbackContact,
}: {
  contacts: readonly AvatarContact[];
  fallbackContact?: AvatarContact | undefined;
  className?: string;
  messages?: readonly OrchestratorMessage[] | undefined;
  work?: readonly OrchestratorWorkItem[] | undefined;
  activity?: OrchestratorActivity | undefined;
  idle?: boolean;
}) {
  const [activityTime, setActivityTime] = useState(() => Date.now());
  useEffect(() => {
    const now = Date.now();
    const nextExpiry = Math.min(
      ...activity.map((item) => item.expiresAt).filter((expiresAt) => expiresAt > now),
    );
    if (!Number.isFinite(nextExpiry)) return;
    const timer = setTimeout(() => setActivityTime(Date.now()), Math.max(0, nextExpiry - now));
    return () => clearTimeout(timer);
  }, [activity, activityTime]);
  const avatar = (contact: AvatarContact | undefined, classes?: string) => (
    <OrchestratorAvatar
      key={contact?.id ?? "default"}
      contact={contact}
      className={classes}
      idle={idle}
      expression={
        messages.findLast(
          (message) => message.senderKind === "orchestrator" && message.senderId === contact?.id,
        )?.expression
      }
      reactionKey={
        messages.findLast(
          (message) => message.senderKind === "orchestrator" && message.senderId === contact?.id,
        )?.id
      }
      status={avatarWorkStatus(contact, work, activity)}
    />
  );
  if (contacts.length <= 1) return avatar(contacts[0] ?? fallbackContact, className);
  return (
    <span className={cn("flex shrink-0 -space-x-2", className)}>
      {contacts.slice(0, 3).map((contact) => avatar(contact, "size-9"))}
    </span>
  );
}
