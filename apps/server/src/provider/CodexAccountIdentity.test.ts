import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { readCodexAccountIdentity } from "./CodexAccountIdentity.ts";

it.effect("detects account switches and sign-out without treating token rotation as a switch", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped();
    const authPath = path.join(home, "auth.json");
    const read = readCodexAccountIdentity(home, {});
    const signedOut = yield* read;
    yield* fs.writeFileString(authPath, '{"tokens":{"account_id":"work","access_token":"one"}}');
    const work = yield* read;
    assert.notEqual(work, signedOut);
    yield* fs.writeFileString(authPath, '{"tokens":{"account_id":"work","access_token":"two"}}');
    assert.equal(yield* read, work);
    yield* fs.writeFileString(authPath, '{"tokens":{"account_id":"personal"}}');
    assert.notEqual(yield* read, work);
    assert.equal(yield* readCodexAccountIdentity("", { CODEX_HOME: home }), yield* read);
    yield* fs.writeFileString(authPath, "{");
    assert.equal(yield* read, undefined);
    yield* fs.remove(authPath);
    assert.equal(yield* read, signedOut);
  }).pipe(Effect.provide(NodeServices.layer)),
);
