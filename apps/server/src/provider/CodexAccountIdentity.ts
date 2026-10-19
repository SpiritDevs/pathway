import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../pathExpansion.ts";

const AuthIdentity = Schema.fromJsonString(
  Schema.Struct({
    OPENAI_API_KEY: Schema.optional(Schema.NullOr(Schema.String)),
    tokens: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          account_id: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  }),
);

/** Compare account identity, not rotating access or refresh tokens. Never expose credentials. */
export const readCodexAccountIdentity = Effect.fn("readCodexAccountIdentity")(function* (
  homePath: string,
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path.pipe(Effect.provide(NodePath.layer));
  const home = expandHomePath(
    homePath || environment.CODEX_HOME || path.join(NodeOS.homedir(), ".codex"),
  );
  return yield* fs.readFileString(path.join(home, "auth.json")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AuthIdentity)),
    Effect.map((auth) =>
      NodeCrypto.createHash("sha256")
        .update(JSON.stringify([auth.tokens?.account_id ?? null, auth.OPENAI_API_KEY ?? null]))
        .digest("hex"),
    ),
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound" ? Effect.succeed("signed-out") : Effect.void,
    ),
    Effect.orElseSucceed(() => undefined),
  );
});
