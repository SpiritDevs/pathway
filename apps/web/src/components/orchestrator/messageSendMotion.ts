export interface ComposerSendMotion {
  chatId: string;
  messageId: string;
  origin: Pick<DOMRect, "left" | "top" | "width" | "height">;
  ready: boolean;
}

export function messageFlightTransform(
  origin: ComposerSendMotion["origin"],
  destination: ComposerSendMotion["origin"],
) {
  const x =
    origin.left +
    Math.min(origin.width, destination.width) / 2 -
    destination.left -
    destination.width / 2;
  const y =
    origin.top +
    Math.min(origin.height, destination.height) / 2 -
    destination.top -
    destination.height / 2;
  return `translate(${x}px, ${y}px) scale(0.96)`;
}

/** A temporary layer lets the message cross the scroll area's edge without moving its layout. */
export function animateSentMessage(
  bubble: HTMLElement,
  scroller: HTMLElement,
  origin: ComposerSendMotion["origin"],
) {
  const surface = scroller.closest<HTMLElement>("[data-conversation-surface]");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (!surface || reduceMotion.matches || document.visibilityState !== "visible") return;
  const destination = bubble.getBoundingClientRect();
  // Very long messages keep their readable layout instead of scaling a screenful of text.
  if (!destination.width || destination.height > scroller.clientHeight) return;
  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.dataset.messageFlight = "";
  Object.assign(layer.style, {
    position: "absolute",
    inset: "0",
    overflow: "clip",
    pointerEvents: "none",
    zIndex: "30",
  });
  surface.append(layer);
  const bounds = layer.getBoundingClientRect();
  const flyingBubble = bubble.cloneNode(true) as HTMLElement;
  flyingBubble.removeAttribute("data-message-id");
  Object.assign(flyingBubble.style, {
    position: "absolute",
    left: `${destination.left - bounds.left}px`,
    top: `${destination.top - bounds.top}px`,
    width: `${destination.width}px`,
    height: `${destination.height}px`,
    margin: "0",
    opacity: "1",
    font: getComputedStyle(bubble).font,
    transformOrigin: "center",
    willChange: "transform, opacity",
  });
  layer.append(flyingBubble);
  const previousOpacity = bubble.style.opacity;
  bubble.style.opacity = "0";
  const animation = flyingBubble.animate(
    [
      { transform: messageFlightTransform(origin, destination), opacity: 0.65 },
      { transform: "translate(0, 0) scale(1)", opacity: 1 },
    ],
    { duration: 380, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)", fill: "both" },
  );
  let disposed = false;
  const scrollTop = scroller.scrollTop;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    bubble.style.opacity = previousOpacity;
    layer.remove();
    animation.cancel();
    window.removeEventListener("resize", cleanup);
    document.removeEventListener("visibilitychange", cleanup);
    reduceMotion.removeEventListener("change", cleanup);
    scroller.removeEventListener("scroll", onScroll);
  };
  const onScroll = () => {
    if (scroller.scrollTop !== scrollTop) cleanup();
  };
  window.addEventListener("resize", cleanup);
  document.addEventListener("visibilitychange", cleanup);
  reduceMotion.addEventListener("change", cleanup);
  scroller.addEventListener("scroll", onScroll, { passive: true });
  void animation.finished.then(cleanup, cleanup);
  return cleanup;
}
