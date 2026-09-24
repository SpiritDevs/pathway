import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";

import { computerSessionAuthPath, makeComputerSessionAuth } from "./computerSessionAuth.ts";

const BUS_ID = "3f0a9c2e1b4d4e5f8a6b7c8d9e0f1a2b";

/** A scratch directory for one test, removed with the test's scope. */
const scratch = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "pathway-computer-auth-" });
});

/** Opens an auth in its own scope, so a test can close it and look afterwards. */
const openAuth = (busId: string, directory: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const auth = yield* makeComputerSessionAuth(busId, directory).pipe(Scope.provide(scope));
    return { ...auth, close: Scope.close(scope, Exit.void) };
  });

describe.skipIf(process.platform === "win32")("makeComputerSessionAuth", () => {
  it.layer(NodeServices.layer)((it) => {
    for (const [label, busId] of [
      ["a space", "abc def"],
      ["a slash", "abc/def"],
      ["a parent segment", "../etc"],
      ["a dot", "abc.def"],
      ["an empty id", ""],
      ["more than 128 characters", "a".repeat(129)],
    ] as const) {
      it.effect(`refuses a bus id with ${label}`, () =>
        Effect.scoped(
          Effect.gen(function* () {
            const directory = yield* scratch;
            const error = yield* Effect.flip(openAuth(busId, directory));
            expect(error._tag).toBe("ComputerSessionAuthError");
          }),
        ),
      );
    }

    it.effect("accepts a machine bus id and writes a private token file", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* scratch;
          const path = yield* computerSessionAuthPath(directory, BUS_ID);
          const auth = yield* openAuth(BUS_ID, directory);
          expect(auth.token).toMatch(/^[0-9a-f]{64}$/);
          const info = yield* fs.stat(path);
          expect(info.type).toBe("File");
          expect(info.mode & 0o777).toBe(0o600);
          expect(yield* fs.readFileString(path)).toBe(auth.token);
          yield* auth.close;
        }),
      ),
    );

    it.effect("accepts an id at the 128 character limit", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* scratch;
          const busId = "b".repeat(128);
          const auth = yield* openAuth(busId, directory);
          yield* auth.close;
          expect(yield* fs.exists(yield* computerSessionAuthPath(directory, busId))).toBe(false);
        }),
      ),
    );

    it.effect("refuses a symlink at the token path", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* scratch;
          const path = yield* computerSessionAuthPath(directory, BUS_ID);
          const target = `${directory}/elsewhere`;
          yield* fs.writeFileString(target, "victim");
          yield* fs.symlink(target, path);
          yield* Effect.flip(openAuth(BUS_ID, directory));
          // Neither the link nor its target was touched: nothing followed or
          // replaced the link.
          expect(yield* fs.readLink(path)).toBe(target);
          expect(yield* fs.readFileString(target)).toBe("victim");
        }),
      ),
    );

    it.effect("replaces a stale regular file owned by this user", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* scratch;
          const path = yield* computerSessionAuthPath(directory, BUS_ID);
          yield* fs.writeFileString(path, "stale token", { mode: 0o644 });
          const auth = yield* openAuth(BUS_ID, directory);
          expect(yield* fs.readFileString(path)).toBe(auth.token);
          expect((yield* fs.stat(path)).mode & 0o777).toBe(0o600);
          yield* auth.close;
        }),
      ),
    );

    it.effect("removes the file on close only while it still holds this token", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* scratch;
          const path = yield* computerSessionAuthPath(directory, BUS_ID);
          const first = yield* openAuth(BUS_ID, directory);
          yield* first.close;
          expect(yield* fs.exists(path)).toBe(false);

          const second = yield* openAuth(BUS_ID, directory);
          // A newer server replaced the file (or an unrelated file appeared).
          // Closing the old auth must not take the newer server's token with it.
          yield* fs.writeFileString(path, "successor token");
          yield* second.close;
          expect(yield* fs.readFileString(path)).toBe("successor token");

          // Closing after the file is gone is a no-op, not a failure.
          yield* fs.remove(path);
          const third = yield* openAuth(BUS_ID, directory);
          yield* fs.remove(path);
          yield* third.close;
        }),
      ),
    );

    it.effect("never reuses a token between sessions", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* scratch;
          const first = yield* openAuth(BUS_ID, directory);
          yield* first.close;
          const second = yield* openAuth(BUS_ID, directory);
          yield* second.close;
          expect(second.token).not.toBe(first.token);
        }),
      ),
    );
  });
});
