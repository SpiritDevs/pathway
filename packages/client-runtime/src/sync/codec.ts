/**
 * Codec seam between the engine and a domain.
 *
 * The engine stores and ships encoded payloads and only ever decodes through a domain-supplied
 * codec, so a payload written by a newer client (or a table the local build does not know) is
 * quarantined instead of corrupting the replica.
 *
 * @module sync/codec
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface SyncCodec<A> {
  /** `Option.none()` means "this build cannot read that payload"; the caller quarantines it. */
  readonly decode: (input: unknown) => Option.Option<A>;
  /** JSON-safe encoding written to the wire and to local storage. */
  readonly encode: (value: A) => unknown;
}

/** Builds a codec from an Effect schema — the normal way a domain declares one. */
export function syncCodec<A, I>(schema: Schema.Codec<A, I>): SyncCodec<A> {
  const decode = Schema.decodeUnknownOption(schema);
  const encode = Schema.encodeSync(schema);
  return {
    decode: (input) => decode(input),
    encode: (value) => encode(value) as unknown,
  };
}
