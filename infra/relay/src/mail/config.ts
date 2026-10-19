import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
export const loadMailConfiguration = Effect.gen(function* () {
  const enabled = yield* Config.boolean("MAIL_ENABLED").pipe(Config.withDefault(false));
  if (!enabled) return undefined;
  return {
    encryptionKey: yield* Config.redacted("MAIL_ENCRYPTION_KEY"),
    uploadThingApiKey: yield* Config.redacted("MAIL_UPLOADTHING_API_KEY"),
    pubsubTopic: yield* Config.string("MAIL_GOOGLE_PUBSUB_TOPIC").pipe(Config.withDefault("")),
    pubsubServiceAccount: yield* Config.string("MAIL_GOOGLE_PUBSUB_SERVICE_ACCOUNT").pipe(
      Config.withDefault(""),
    ),
    hostedClientId: yield* Config.string("MAIL_GOOGLE_CLIENT_ID").pipe(Config.withDefault("")),
    hostedClientSecret: yield* Config.redacted("MAIL_GOOGLE_CLIENT_SECRET").pipe(
      Config.withDefault(Redacted.make("")),
    ),
  };
});
export type MailConfiguration = NonNullable<Effect.Success<typeof loadMailConfiguration>>;

export class MailQueueError extends Schema.TaggedErrorClass<MailQueueError>()("MailQueueError", {
  message: Schema.String,
}) {}
