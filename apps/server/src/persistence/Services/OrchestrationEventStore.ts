/**
 * Historical name for the shared application event store.
 *
 * Owns durable append/replay access for project events and V2 agent-thread
 * events under one global sequence. It does not reduce events into read models
 * or apply command validation rules.
 *
 * Uses Effect `Context.Service` for dependency injection and exposes typed
 * persistence/decode errors for event append and replay operations.
 *
 * @module OrchestrationEventStore
 */
import type {
  ApplicationStoredEvent,
  CommandId,
  OrchestrationV2DomainEvent,
  OrchestrationV2StoredEvent,
  ProjectId,
  ThreadId,
} from "@spiritdevs/contracts";
import type { OrchestrationEvent } from "@spiritdevs/contracts/legacy-orchestration";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { OrchestrationEventStoreError } from "../Errors.ts";

/**
 * The newest retained event for one project or thread, without its payload.
 * Shell catch-up only needs which aggregates changed, and how a thread left.
 */
export type ApplicationAggregateChange =
  | {
      readonly aggregateKind: "project";
      readonly projectId: ProjectId;
      readonly sequence: number;
      readonly deleted: boolean;
    }
  | {
      readonly aggregateKind: "thread";
      readonly threadId: ThreadId;
      readonly sequence: number;
      /** The newest event deleted the thread while it was archived. */
      readonly deletedFromArchive: boolean;
    };

/**
 * OrchestrationEventStoreShape - Service API for orchestration event persistence.
 */
export interface OrchestrationEventStoreShape {
  /**
   * Persist a new orchestration event.
   *
   * @param event - Event payload without sequence (assigned by storage).
   * @returns Effect containing the stored event with assigned sequence.
   *
   * Actor kind is inferred from command/metadata before persistence.
   */
  readonly append: (
    event: Omit<OrchestrationEvent, "sequence">,
  ) => Effect.Effect<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Replay events after the provided sequence.
   *
   * @param sequenceExclusive - Sequence cursor (exclusive).
   * @param limit - Maximum number of events to emit.
   * @returns Stream containing ordered events.
   *
   * Reads in fixed-size pages and normalizes non-integer/negative limits.
   */
  readonly readFromSequence: (
    sequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Read all events from the beginning of the stream.
   *
   * @returns Stream containing all stored events.
   */
  readonly readAll: () => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /** Append V2 agent events to the same globally ordered application log. */
  readonly appendAgentEvents: (input: {
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, OrchestrationEventStoreError>;

  /** Read only V2 thread events from the application log. */
  readonly readAgentEvents: (input?: {
    readonly afterSequence?: number;
    readonly throughSequence?: number;
    readonly threadId?: ThreadId;
    readonly commandId?: CommandId;
    readonly limit?: number;
  }) => Stream.Stream<OrchestrationV2StoredEvent, OrchestrationEventStoreError>;

  readonly latestAgentSequence: (
    threadId?: ThreadId,
  ) => Effect.Effect<number, OrchestrationEventStoreError>;

  readonly latestApplicationSequence: Effect.Effect<number, OrchestrationEventStoreError>;

  /** Read the finite retained application-event range `(afterSequence, throughSequence]`. */
  readonly readApplicationEvents: (input: {
    readonly afterSequence: number;
    readonly throughSequence: number;
  }) => Stream.Stream<ApplicationStoredEvent, OrchestrationEventStoreError>;

  /**
   * The newest event per project/thread in `(afterSequence, throughSequence]`,
   * ordered by sequence. Reads no event payloads beyond those newest rows.
   */
  readonly readApplicationAggregateChanges: (input: {
    readonly afterSequence: number;
    readonly throughSequence: number;
  }) => Effect.Effect<ReadonlyArray<ApplicationAggregateChange>, OrchestrationEventStoreError>;

  /** Publish only after the surrounding event/projection transaction commits. */
  readonly publishCommitted: (events: ReadonlyArray<ApplicationStoredEvent>) => Effect.Effect<void>;

  /** Race-free replay-to-live stream for project and V2 thread events. */
  readonly streamApplicationEvents: (input?: {
    readonly afterSequence?: number;
  }) => Stream.Stream<ApplicationStoredEvent, OrchestrationEventStoreError>;
}

/**
 * OrchestrationEventStore - Service tag for orchestration event persistence.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const events = yield* OrchestrationEventStore
 *   return yield* Stream.runCollect(events.readAll())
 * })
 * ```
 */
export class OrchestrationEventStore extends Context.Service<
  OrchestrationEventStore,
  OrchestrationEventStoreShape
>()("@spiritdevs/pathway/persistence/Services/OrchestrationEventStore") {}
