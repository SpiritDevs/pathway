import { type EnvironmentId, type ThreadId } from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * The desktop host and tab a takeover pinned. Captured while the automation
 * fence is acquired — not looked up later — so the user is handed the exact tab
 * the agent was driving even if routing would otherwise have moved on.
 */
export interface PreviewTakeoverLease {
  readonly hostClientId: string;
  readonly hostConnectionId: string;
  readonly tabId: string | null;
}

/**
 * Acquiring exclusivity failed. The fence stays armed on failure: automation
 * must remain blocked until the caller explicitly releases, so a half-finished
 * takeover never silently hands the browser back to the agent.
 */
export class PreviewTakeoverFenceError extends Schema.TaggedErrorClass<PreviewTakeoverFenceError>()(
  "PreviewTakeoverFenceError",
  {
    reason: Schema.Literals(["no_live_host", "host_disconnected", "drain_failed"]),
    environmentId: Schema.optional(Schema.String),
    threadId: Schema.optional(Schema.String),
    takeoverId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Preview takeover fence could not be acquired: ${this.reason}.`;
  }
}

/**
 * Exclusive control of one thread's preview automation.
 *
 * Implemented by {@link PreviewAutomationBroker}'s module (it shares the broker
 * state ref) and driven by the orchestration-v2 takeover service. Kept as a
 * separate seam so orchestration depends on this interface rather than on the
 * broker, and so tests can substitute a stub fence.
 */
export class PreviewAutomationTakeoverFence extends Context.Service<
  PreviewAutomationTakeoverFence,
  {
    /**
     * Fences all new automation for the environment+thread immediately, then
     * waits for in-flight requests for that thread to settle (bounded by
     * `drainTimeoutMs`), cancelling stragglers with
     * `PreviewAutomationTakeoverActiveError`. Resolves only once exclusivity
     * actually holds, and captures the pinned host and tab at that moment.
     * Fails when the thread has no live host assignment.
     */
    readonly acquire: (input: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly takeoverId: string;
      readonly drainTimeoutMs?: number;
    }) => Effect.Effect<PreviewTakeoverLease, PreviewTakeoverFenceError>;
    /** Idempotent. An unknown `takeoverId` is a no-op. */
    readonly release: (input: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly takeoverId: string;
    }) => Effect.Effect<void>;
    /**
     * Re-arms a fence from durable state after a server restart. No drain:
     * nothing survived the restart in flight.
     */
    readonly rearm: (input: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly takeoverId: string;
      readonly hostClientId: string | null;
      readonly hostConnectionId: string | null;
      readonly tabId: string | null;
    }) => Effect.Effect<void>;
  }
>()("@spiritdevs/pathway/mcp/PreviewAutomationTakeover/PreviewAutomationTakeoverFence") {}

/**
 * One preview automation host/tab observation for a thread. The broker emits
 * these only when the (providerSessionId, hostClientId, tabId) tuple changes,
 * never per browser action.
 */
export interface PreviewActivityRecord {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly tabId: string | null;
  readonly hostClientId: string;
}

/**
 * Where the broker publishes coalesced preview activity. The default drops
 * records so broker tests need no extra layer; the live implementation lives in
 * orchestration-v2 and dispatches `thread.preview-activity.record`.
 */
export class PreviewAutomationActivitySink extends Context.Reference<{
  readonly record: (record: PreviewActivityRecord) => Effect.Effect<void>;
}>("@spiritdevs/pathway/mcp/PreviewAutomationTakeover/PreviewAutomationActivitySink", {
  defaultValue: () => ({ record: () => Effect.void }),
}) {}
