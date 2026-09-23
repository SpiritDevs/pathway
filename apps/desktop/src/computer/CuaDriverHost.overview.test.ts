import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeFixture } from "./testing/CuaDriverFixture.ts";

describe("overview normalization", () => {
  it.live("replies with the normalized overview, not the driver's full-size image", () =>
    Effect.gen(function* () {
      const seen: Array<string | undefined> = [];
      const f = yield* makeFixture({
        normalizeOverview: (result) => {
          seen.push(result.content?.[0]?.data);
          return {
            ...result,
            content: [{ type: "image", data: "resized", mimeType: "image/png" }],
          };
        },
      });
      const reply = yield* f.send({ method: "call", name: "get_desktop_state" });
      assert.deepStrictEqual(seen, ["fixture-image"]);
      assert.deepStrictEqual(reply.result?.content, [
        { type: "image", data: "resized", mimeType: "image/png" },
      ]);
    }),
  );
});
