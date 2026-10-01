/**
 * The shared secret that proves a D-Bus connection to a compositor plugin is
 * this Pathway server's.
 *
 * The plugin accepts `authenticate(token)` only from the connection that owns
 * `com.spiritdevs.pathway.ComputerUse.Server`, and compares the token with the
 * one in a private file it reads from `/tmp`. The file is created only while
 * the caller holds that exclusive name, so a second server on the same bus
 * cannot race its own token in.
 *
 * @module computer/computerSessionAuth
 */
import { randomBytes } from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export const COMPUTER_SERVER_OWNER = "com.spiritdevs.pathway.ComputerUse.Server";

export class ComputerSessionAuthError extends Schema.TaggedErrorClass<ComputerSessionAuthError>()(
  "ComputerSessionAuthError",
  { message: Schema.String },
) {}

export interface ComputerSessionAuth {
  readonly token: string;
}

const BUS_ID = /^[a-zA-Z0-9_-]{1,128}$/;

/** The token file the plugin reads for this user and bus. */
export const computerSessionAuthPath = (directory: string, busId: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(directory, `pathway-computer-use-${process.getuid!()}-${busId}.token`);
  });

/**
 * Writes a fresh token for `busId` and removes it when the scope closes, but
 * only while the file still holds this token: a newer server that replaced it
 * keeps its own. `directory` is `/tmp` in production, where the plugin looks;
 * tests point it at a scratch directory.
 *
 * A symbolic link at the path is refused, never followed or replaced, and so is
 * anything that is not a regular file this user owns.
 */
export const makeComputerSessionAuth = Effect.fn("makeComputerSessionAuth")(function* (
  busId: string,
  directory = "/tmp",
): Effect.fn.Return<
  ComputerSessionAuth,
  ComputerSessionAuthError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  if (!BUS_ID.test(busId)) {
    return yield* new ComputerSessionAuthError({ message: "Invalid D-Bus session identifier." });
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* computerSessionAuthPath(directory, busId);
  const unsafe = () =>
    new ComputerSessionAuthError({ message: "Unsafe computer authentication file." });
  const failed = (error: { readonly message: string }) =>
    new ComputerSessionAuthError({ message: error.message });

  const isLink = yield* fs.readLink(path).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
  if (isLink) return yield* unsafe();
  const previous = yield* fs.stat(path).pipe(
    Effect.map(Option.some),
    Effect.catch((error) =>
      error.reason._tag === "NotFound" ? Effect.succeedNone : Effect.fail(failed(error)),
    ),
  );
  if (Option.isSome(previous)) {
    const info = previous.value;
    if (info.type !== "File" || Option.getOrUndefined(info.uid) !== process.getuid!()) {
      return yield* unsafe();
    }
    yield* fs.remove(path).pipe(Effect.mapError(failed));
  }

  const token = randomBytes(32).toString("hex");
  yield* Effect.acquireRelease(
    fs.writeFileString(path, token, { mode: 0o600, flag: "wx" }).pipe(Effect.mapError(failed)),
    () =>
      fs.readFileString(path).pipe(
        Effect.flatMap((current) => (current === token ? fs.remove(path) : Effect.void)),
        Effect.ignore,
      ),
  );
  return { token };
});
