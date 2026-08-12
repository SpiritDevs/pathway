export type CollapsedComposerAction = "send" | "stop";

/** A typed draft remains sendable while a run is active; only an empty pill becomes Stop. */
export function resolveCollapsedComposerAction(input: {
  readonly canStopThread: boolean;
  readonly hasContent: boolean;
}): CollapsedComposerAction {
  return input.canStopThread && !input.hasContent ? "stop" : "send";
}
