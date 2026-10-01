import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  COMPUTER_TEXT_MAX_LENGTH,
  type ChatImageAttachment,
  type CommandId,
  type MessageId,
  type ComputerSurfaceInput,
  type ComputerSurfaceSessionState,
  type ScopedThreadRef,
  type ThreadId,
} from "@spiritdevs/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@spiritdevs/client-runtime/state/runtime";
import { MonitorIcon, MonitorOffIcon } from "lucide-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { surfaceIndicator, wheelPixels } from "~/browser/remoteBrowserSurface";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { KEYBINDING_CAPTURE_ATTRIBUTE } from "~/keybindings";
import { cn, newCommandId, newMessageId } from "~/lib/utils";
import { computerEnvironment } from "~/state/computer";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentSurface } from "~/surface/useEnvironmentSurface";

import { createComputerClickDispatch } from "./computerClickDispatch";
import { createComputerInputQueue } from "./computerInputQueue";
import {
  COMPUTER_LOST_CONTROL_NOTICE,
  computerControlView,
  createComputerControlLease,
  drainComputerInput,
  computerHandBackThreadId,
  computerKeyInput,
  computerModifiers,
  computerPointerButton,
  computerSurfacePoint,
  type ComputerControlTone,
} from "./computerSurface.logic";

function failureText(outcome: AtomCommandResult<unknown, unknown>, fallback: string) {
  if (outcome._tag === "Success") return null;
  const failure = squashAtomCommandFailure(outcome);
  return failure instanceof Error && failure.message ? failure.message : fallback;
}

const TONE_DOT: Record<ComputerControlTone, string> = {
  agent: "bg-info",
  mine: "bg-emerald-500",
  other: "bg-amber-500",
  idle: "bg-muted-foreground",
};

/**
 * The environment's screen as a persistent right-panel surface. It streams
 * while on screen, outlives the agent's turn, and lets this connection take
 * control, then hand back with a follow-up for the agent.
 */
export function ComputerSurfaceView({ threadRef }: { threadRef: ScopedThreadRef }) {
  const atom = useMemo(
    () => computerEnvironment.surfaceState({ environmentId: threadRef.environmentId, input: {} }),
    [threadRef.environmentId],
  );
  const result = useAtomValue(atom);
  const reconnect = useAtomRefresh(atom);

  if (AsyncResult.isFailure(result)) {
    const error = squashAtomCommandFailure(result);
    return (
      <CenteredNotice title="The computer view disconnected.">
        {error instanceof Error ? <p className="max-w-sm text-xs">{error.message}</p> : null}
        <Button size="xs" variant="outline" disabled={result.waiting} onClick={reconnect}>
          Reconnect
        </Button>
      </CenteredNotice>
    );
  }
  if (!AsyncResult.isSuccess(result)) return <CenteredNotice title="Connecting to the computer…" />;
  if (!result.value.state.capabilities.capture) {
    return (
      <CenteredNotice
        icon={<MonitorOffIcon className="size-5" />}
        title="This environment's screen can't be viewed."
      >
        <p className="max-w-sm text-xs">
          Computer use isn't set up on this environment, or its host can't share its screen.
        </p>
      </CenteredNotice>
    );
  }
  return <ComputerSurface threadRef={threadRef} session={result.value} />;
}

function CenteredNotice(props: {
  title: string;
  icon?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground"
    >
      {props.icon}
      <p>{props.title}</p>
      {props.children}
    </div>
  );
}

/** One follow-up; its ids are allocated once so every retry is the same command. */
interface PendingFollowUp {
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly message: string;
  readonly summary: string;
  readonly attachment: ChatImageAttachment;
}

function ComputerSurface({
  threadRef,
  session,
}: {
  threadRef: ScopedThreadRef;
  session: ComputerSurfaceSessionState;
}) {
  const environmentId = threadRef.environmentId;
  const control = computerControlView(session);
  const { capabilities } = session.state;
  const interactive = control.mine && capabilities.input;

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surface = useEnvironmentSurface({
    environmentId,
    target: { kind: "computer", computerId: session.state.computerId },
    enabled: true,
    containerRef,
    canvasRef,
  });
  const indicator = surfaceIndicator(surface.state, surface.quality);

  const takeControl = useAtomCommand(computerEnvironment.takeSurfaceControl, {
    reportFailure: false,
  });
  const releaseControl = useAtomCommand(computerEnvironment.releaseSurfaceControl, {
    reportFailure: false,
  });
  const sendInput = useAtomCommand(computerEnvironment.surfaceInput, { reportFailure: false });
  const handBack = useAtomCommand(computerEnvironment.surfaceHandBack, { reportFailure: false });
  const dispatchFollowUp = useAtomCommand(threadEnvironment.dispatchComputerHandBack, {
    reportFailure: false,
  });

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingFollowUp, setPendingFollowUp] = useState<PendingFollowUp | null>(null);

  // Set just before this client gives control up itself, so only a loss it
  // did not ask for (Escape, another path) reads as "you lost control".
  const leavingRef = useRef(false);
  const escapedRef = useRef(false);
  const wasMine = useRef(control.mine);
  useEffect(() => {
    if (wasMine.current && !control.mine && !leavingRef.current) {
      setNotice(
        escapedRef.current
          ? COMPUTER_LOST_CONTROL_NOTICE.escape
          : COMPUTER_LOST_CONTROL_NOTICE.other,
      );
    }
    if (!control.mine) leavingRef.current = false;
    escapedRef.current = false;
    wasMine.current = control.mine;
  }, [control.mine]);

  const queue = useMemo(
    () =>
      createComputerInputQueue({
        onError: (cause) =>
          setError(cause instanceof Error ? cause.message : "The computer did not respond."),
      }),
    [],
  );
  // Plain left clicks wait briefly so a browser double click reaches the host
  // as one double click rather than a single and a double.
  const clicks = useMemo(
    () =>
      createComputerClickDispatch({
        dispatch: ({ x, y, clickCount }) =>
          enqueueRef.current({
            type: "pointer.click",
            x,
            y,
            button: "left",
            ...(clickCount === 2 ? { clickCount } : {}),
          }),
      }),
    [],
  );
  useEffect(() => {
    if (interactive) return;
    clicks.cancel();
    queue.clear();
  }, [clicks, interactive, queue]);

  // Every give-up path (release, hand back, closing, hiding) lands queued input
  // first, and a takeover that lands after the view left is released.
  const releaseRef = useRef(releaseControl);
  releaseRef.current = releaseControl;
  const lease = useMemo(
    () =>
      createComputerControlLease({
        release: () => releaseRef.current({ environmentId, input: {} }),
        drainInput: () => drainComputerInput(clicks, queue),
      }),
    [clicks, environmentId, queue],
  );
  const mineRef = useRef(control.mine);
  mineRef.current = control.mine;
  useEffect(() => () => void lease.leave(mineRef.current), [lease]);

  // Nobody can steer a screen they can't see: a hidden tab gives control back.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") return;
      if (!lease.leave(mineRef.current)) return;
      leavingRef.current = true;
      setNotice(COMPUTER_LOST_CONTROL_NOTICE.hidden);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [lease]);

  const enqueue = (event: ComputerSurfaceInput) => {
    queue.push(async () => {
      const outcome = await sendInput({ environmentId, input: { event } });
      const message = failureText(outcome, "The computer did not respond.");
      if (message) throw new Error(message);
      setError(null);
    });
  };
  const enqueueRef = useRef(enqueue);
  enqueueRef.current = enqueue;
  const send = (event: ComputerSurfaceInput) => {
    if (!lease.accepting()) return;
    clicks.flush();
    enqueue(event);
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  const screenPoint = (event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    const screen = surface.pageSize.current;
    if (!canvas || !screen) return null;
    const box = canvas.getBoundingClientRect();
    return computerSurfacePoint({
      x: event.clientX - box.left,
      y: event.clientY - box.top,
      boxWidth: box.width,
      boxHeight: box.height,
      screen,
    });
  };
  const screenPointRef = useRef(screenPoint);
  screenPointRef.current = screenPoint;

  // Wheel, and pointer moves on hosts with pointer phases, coalesce to one
  // send per animation frame; nothing is scheduled while the pointer rests.
  const pointerPhases = capabilities.pointerPhases;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !interactive) return;
    let frame = 0;
    let move: ComputerSurfaceInput | null = null;
    let wheel: Extract<ComputerSurfaceInput, { type: "wheel" }> | null = null;
    const flush = () => {
      frame = 0;
      if (wheel) sendRef.current(wheel);
      if (move) sendRef.current(move);
      wheel = null;
      move = null;
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(flush);
    };
    const onMove = (event: PointerEvent) => {
      const point = screenPointRef.current(event);
      if (!point) return;
      move = { type: "pointer.move", ...point };
      schedule();
    };
    const onWheel = (event: WheelEvent) => {
      const point = screenPointRef.current(event);
      if (!point) return;
      const delta = wheelPixels(event, surface.pageSize.current?.height ?? 0);
      const modifiers = computerModifiers(event);
      wheel = {
        type: "wheel",
        ...point,
        deltaX: clampDelta((wheel?.deltaX ?? 0) + delta.deltaX),
        deltaY: clampDelta((wheel?.deltaY ?? 0) + delta.deltaY),
        ...(modifiers.length > 0 ? { modifiers } : {}),
      };
      schedule();
    };
    if (pointerPhases) canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [interactive, pointerPhases, surface.pageSize]);

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    try {
      setError(await action());
    } finally {
      setBusy(false);
    }
  };

  const onTakeControl = () =>
    run(async () => {
      setNotice(null);
      let failure: string | null = null;
      const acquired = await lease.acquire(async () => {
        const outcome = await takeControl({ environmentId, input: {} });
        failure = failureText(outcome, "Could not take control.");
        return outcome._tag === "Success";
      });
      if (acquired) canvasRef.current?.focus();
      return failure;
    });

  const onRelease = () =>
    run(async () => {
      leavingRef.current = true;
      const outcome = await lease.relinquish(() => releaseControl({ environmentId, input: {} }));
      if (outcome._tag === "Failure") {
        leavingRef.current = false;
        lease.resume();
      }
      return failureText(outcome, "Could not release control.");
    });

  const dispatch = async (followUp: PendingFollowUp) => {
    const outcome = await dispatchFollowUp({
      environmentId,
      input: {
        threadId: followUp.threadId,
        commandId: followUp.commandId,
        messageId: followUp.messageId,
        message: followUp.message,
        summary: followUp.summary,
        attachment: followUp.attachment,
      },
    });
    const failure = failureText(outcome, "Could not send your message to the agent.");
    // The hand-back already happened; keep the capture and summary for a retry.
    setPendingFollowUp(failure ? followUp : null);
    return failure;
  };

  const onHandBack = (event: FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message) {
      void onRelease();
      return;
    }
    void run(async () => {
      const threadId = computerHandBackThreadId(session, threadRef.threadId);
      const messageId = newMessageId();
      leavingRef.current = true;
      // The capture and summary must include every click and keystroke already sent.
      const outcome = await lease.relinquish(() =>
        handBack({ environmentId, input: { threadId, messageId } }),
      );
      if (outcome._tag === "Failure") {
        leavingRef.current = false;
        lease.resume();
        // Control is kept on failure, so the user can retry or just release.
        return failureText(outcome, "Could not hand back to the agent.");
      }
      setDraft("");
      return dispatch({
        threadId,
        commandId: newCommandId(),
        messageId,
        message,
        summary: outcome.value.summary,
        attachment: outcome.value.attachment,
      });
    });
  };

  const onClick = (event: React.MouseEvent<HTMLCanvasElement>, domButton = event.button) => {
    event.currentTarget.focus();
    if (pointerPhases) return;
    const button = computerPointerButton(domButton);
    const point = screenPoint(event);
    if (!button || !point) return;
    const modifiers = computerModifiers(event);
    if (button === "left" && modifiers.length === 0) {
      if (lease.accepting()) clicks.click(point, event.detail);
      return;
    }
    send({
      type: "pointer.click",
      ...point,
      button,
      ...(modifiers.length > 0 ? { modifiers } : {}),
    });
  };

  const onPointerPhase =
    (type: "pointer.down" | "pointer.up") => (event: React.PointerEvent<HTMLCanvasElement>) => {
      const button = computerPointerButton(event.button);
      const point = screenPoint(event);
      if (!button || !point) return;
      if (type === "pointer.down") event.currentTarget.setPointerCapture(event.pointerId);
      const modifiers = computerModifiers(event);
      send({ type, ...point, button, ...(modifiers.length > 0 ? { modifiers } : {}) });
    };

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs">
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", TONE_DOT[control.tone])} />
        <span role="status" className="min-w-0 flex-1 truncate font-medium text-foreground">
          {control.label}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{indicator.label}</span>
        {control.mine ? (
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void onRelease()}>
            Release
          </Button>
        ) : capabilities.input ? (
          <Button
            size="xs"
            disabled={busy || control.tone === "other"}
            title={
              control.tone === "other" ? "Wait for the other device to release control." : undefined
            }
            onClick={() => void onTakeControl()}
          >
            Take control
          </Button>
        ) : null}
      </div>
      {notice ? (
        <p role="alert" className="shrink-0 border-b bg-muted/50 px-3 py-1.5 text-xs">
          {notice}
        </p>
      ) : null}
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden bg-black">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={
            interactive
              ? "The environment's screen. You have control; click to interact and type after clicking. Escape gives control back."
              : "Live view of the environment's screen"
          }
          tabIndex={interactive ? 0 : undefined}
          {...(interactive ? { [KEYBINDING_CAPTURE_ATTRIBUTE]: "" } : {})}
          className={cn(
            "h-full w-full object-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
            !surface.hasFrame && "invisible",
          )}
          onClick={interactive ? (event) => onClick(event) : undefined}
          onContextMenu={
            interactive
              ? (event) => {
                  event.preventDefault();
                  onClick(event, 2);
                }
              : undefined
          }
          onPointerDown={interactive && pointerPhases ? onPointerPhase("pointer.down") : undefined}
          onPointerUp={interactive && pointerPhases ? onPointerPhase("pointer.up") : undefined}
          onKeyDown={
            interactive
              ? (event) => {
                  // While in control every key belongs to the screen, not to app shortcuts.
                  event.stopPropagation();
                  const input = computerKeyInput(event);
                  if (!input) return;
                  // Paste arrives as text through onPaste.
                  if (input.type === "key" && input.key === "V" && (event.metaKey || event.ctrlKey))
                    return;
                  event.preventDefault();
                  if (input.type === "key" && input.key === "Escape") escapedRef.current = true;
                  send(input);
                }
              : undefined
          }
          onPaste={
            interactive
              ? (event) => {
                  event.preventDefault();
                  const text = event.clipboardData
                    .getData("text/plain")
                    .slice(0, COMPUTER_TEXT_MAX_LENGTH);
                  if (text) send({ type: "type", text });
                }
              : undefined
          }
        />
        {!surface.hasFrame ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-white/70">
            <MonitorIcon className="size-5" />
            {surface.state === "failed"
              ? "The screen stream is offline. Retrying…"
              : "Connecting to the screen…"}
          </div>
        ) : null}
        {error ? (
          <p
            role="alert"
            className="absolute top-2 left-1/2 max-w-[80%] -translate-x-1/2 truncate rounded border bg-background/95 px-2 py-1 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
      </div>
      {pendingFollowUp ? (
        <div className="flex shrink-0 items-center gap-2 border-t px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            Your message didn't reach the agent. Your screenshot and actions are kept.
          </span>
          <Button
            size="xs"
            disabled={busy}
            onClick={() => void run(() => dispatch(pendingFollowUp))}
          >
            Retry
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setPendingFollowUp(null)}>
            Discard
          </Button>
        </div>
      ) : control.mine ? (
        <form className="flex shrink-0 items-end gap-2 border-t p-2" onSubmit={onHandBack}>
          <Textarea
            rows={1}
            value={draft}
            placeholder="Tell the agent what's next…"
            aria-label="Message for the agent"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <Button type="submit" size="sm" disabled={busy}>
            {draft.trim() ? "Send & hand back" : "Hand back"}
          </Button>
        </form>
      ) : null}
    </div>
  );
}

function clampDelta(value: number) {
  return Math.max(-10_000, Math.min(10_000, value));
}
