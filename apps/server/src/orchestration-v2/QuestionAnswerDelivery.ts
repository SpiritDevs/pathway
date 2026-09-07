import { CommandId, MessageId, ProviderThreadId, ThreadId } from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

export class QuestionAnswerDeliveryError extends Schema.TaggedErrorClass<QuestionAnswerDeliveryError>()(
  "QuestionAnswerDeliveryError",
  { cause: Schema.optional(Schema.Defect()) },
) {}

export interface QuestionAnswerDeliveryHandlers {
  readonly followUp: (input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly messageId: MessageId;
    readonly commandId: CommandId;
  }) => Effect.Effect<void, QuestionAnswerDeliveryError>;
  readonly failed: (input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
  }) => Effect.Effect<void, QuestionAnswerDeliveryError>;
}

/** Connects outbox delivery back to serialized commands without a service cycle. */
export class QuestionAnswerDelivery extends Context.Service<
  QuestionAnswerDelivery,
  QuestionAnswerDeliveryHandlers & {
    readonly bind: (handlers: QuestionAnswerDeliveryHandlers) => Effect.Effect<void>;
  }
>()("@spiritdevs/pathway/orchestration-v2/QuestionAnswerDelivery") {}

export const layer = Layer.effect(
  QuestionAnswerDelivery,
  Effect.gen(function* () {
    const handlers = yield* Ref.make<QuestionAnswerDeliveryHandlers | null>(null);
    return QuestionAnswerDelivery.of({
      bind: (next) => Ref.set(handlers, next),
      followUp: (input) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(handlers);
          if (current === null)
            return yield* new QuestionAnswerDeliveryError({
              cause: "Question delivery is not ready.",
            });
          yield* current.followUp(input);
        }),
      failed: (input) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(handlers);
          if (current === null)
            return yield* new QuestionAnswerDeliveryError({
              cause: "Question delivery is not ready.",
            });
          yield* current.failed(input);
        }),
    });
  }),
);
