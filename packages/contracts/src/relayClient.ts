import * as Schema from "effect/Schema";

// The server's bundled Pathway Connect connector. `missing` and the `override`/`path` sources
// only come from older servers that downloaded cloudflared.
export const RelayClientStatusSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    executablePath: Schema.String,
    source: Schema.Literals(["override", "managed", "path"]),
    version: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("missing"),
    version: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("unsupported"),
    platform: Schema.String,
    arch: Schema.String,
    version: Schema.String,
  }),
]);
export type RelayClientStatus = typeof RelayClientStatusSchema.Type;
