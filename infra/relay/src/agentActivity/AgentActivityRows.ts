import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { api } from "@t3tools/backend/convexApi";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { RelayConvexClient } from "../db.ts";

export const AGENT_ACTIVITY_PRUNE_BATCH_SIZE = 500;

export class AgentActivityRowUpsertPersistenceError extends Schema.TaggedErrorClass<AgentActivityRowUpsertPersistenceError>()(
  "AgentActivityRowUpsertPersistenceError",
  {
    environmentId: Schema.String,
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist agent activity state for environment ${this.environmentId}, thread ${this.threadId}.`;
  }
}

export class AgentActivityRowDeletePersistenceError extends Schema.TaggedErrorClass<AgentActivityRowDeletePersistenceError>()(
  "AgentActivityRowDeletePersistenceError",
  {
    environmentId: Schema.String,
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to delete agent activity state for environment ${this.environmentId}, thread ${this.threadId}.`;
  }
}

export class AgentActivityRowPruneTerminalPersistenceError extends Schema.TaggedErrorClass<AgentActivityRowPruneTerminalPersistenceError>()(
  "AgentActivityRowPruneTerminalPersistenceError",
  {
    updatedBefore: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to prune terminal agent activity rows updated before ${this.updatedBefore}.`;
  }
}

export class AgentActivityRowListPersistenceError extends Schema.TaggedErrorClass<AgentActivityRowListPersistenceError>()(
  "AgentActivityRowListPersistenceError",
  {
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list agent activity state for user ${this.userId}.`;
  }
}

export class AgentActivityRows extends Context.Service<
  AgentActivityRows,
  {
    readonly upsert: (input: {
      readonly environmentPublicKey: string;
      readonly state: RelayAgentActivityState;
    }) => Effect.Effect<void, AgentActivityRowUpsertPersistenceError>;
    readonly pruneTerminal: (input: {
      readonly updatedBefore: string;
    }) => Effect.Effect<void, AgentActivityRowPruneTerminalPersistenceError>;
    readonly remove: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
      readonly threadId: string;
    }) => Effect.Effect<void, AgentActivityRowDeletePersistenceError>;
    readonly listForUser: (input: {
      readonly userId: string;
    }) => Effect.Effect<
      ReadonlyArray<RelayAgentActivityState>,
      AgentActivityRowListPersistenceError
    >;
    readonly getForUserThread: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly threadId: string;
    }) => Effect.Effect<RelayAgentActivityState | null, AgentActivityRowListPersistenceError>;
  }
>()("pathway-relay/agentActivity/AgentActivityRows") {}

export const make = Effect.gen(function* () {
  const client = yield* RelayConvexClient;

  return AgentActivityRows.of({
    upsert: Effect.fn("relay.agent_activity_rows.upsert")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.state.environmentId,
        "relay.thread_id": input.state.threadId,
      });
      const { detail, ...state } = input.state;
      yield* client
        .mutation(api.relayPersistence.upsertAgentActivityRow, {
          environmentPublicKey: input.environmentPublicKey,
          state: {
            ...state,
            ...(detail === undefined ? {} : { detail }),
          },
          createdAt: DateTime.formatIso(yield* DateTime.now),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new AgentActivityRowUpsertPersistenceError({
                environmentId: input.state.environmentId,
                threadId: input.state.threadId,
                cause,
              }),
          ),
        );
    }),

    remove: Effect.fn("relay.agent_activity_rows.remove")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.environment_id": input.environmentId,
        "relay.thread_id": input.threadId,
      });
      yield* client.mutation(api.relayPersistence.removeAgentActivityRow, input).pipe(
        Effect.mapError(
          (cause) =>
            new AgentActivityRowDeletePersistenceError({
              environmentId: input.environmentId,
              threadId: input.threadId,
              cause,
            }),
        ),
      );
    }),

    pruneTerminal: Effect.fn("relay.agent_activity_rows.prune_terminal")(function* (input) {
      yield* client
        .mutation(api.relayPersistence.pruneTerminalAgentActivityRows, {
          ...input,
          limit: AGENT_ACTIVITY_PRUNE_BATCH_SIZE,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new AgentActivityRowPruneTerminalPersistenceError({
                updatedBefore: input.updatedBefore,
                cause,
              }),
          ),
        );
    }),

    listForUser: Effect.fn("relay.agent_activity_rows.list_for_user")(function* (input) {
      return yield* client.query(api.relayPersistence.listAgentActivityRowsForUser, input).pipe(
        Effect.map((rows) => rows as unknown as ReadonlyArray<RelayAgentActivityState>),
        Effect.mapError(
          (cause) =>
            new AgentActivityRowListPersistenceError({
              userId: input.userId,
              cause,
            }),
        ),
      );
    }),

    getForUserThread: Effect.fn("relay.agent_activity_rows.get_for_user_thread")(function* (input) {
      return yield* client.query(api.relayPersistence.getAgentActivityRowForUserThread, input).pipe(
        Effect.map((row) => row as unknown as RelayAgentActivityState | null),
        Effect.mapError(
          (cause) =>
            new AgentActivityRowListPersistenceError({
              userId: input.userId,
              cause,
            }),
        ),
      );
    }),
  });
});

export const pruneTerminalBatch = Effect.fn("relay.agent_activity_rows.prune_terminal_batch")(
  function* (input: { readonly updatedBefore: string }) {
    const client = yield* RelayConvexClient;
    yield* Effect.annotateCurrentSpan({
      "relay.agent_activity_prune.before": input.updatedBefore,
    });
    return yield* client
      .mutation(api.relayPersistence.pruneTerminalAgentActivityRows, {
        ...input,
        limit: AGENT_ACTIVITY_PRUNE_BATCH_SIZE,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new AgentActivityRowPruneTerminalPersistenceError({
              updatedBefore: input.updatedBefore,
              cause,
            }),
        ),
      );
  },
);

export const layer = Layer.effect(AgentActivityRows, make);
