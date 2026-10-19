import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { cuaSpaceInventory } from "./cuaSpaceInventory.ts";

const space = {
  space_id: 7,
  space_uuid: "space-uuid",
  display_id: "display-a",
  kind: "desktop",
  current: false,
};
const inventory = { source: "macos-managed-spaces", complete: true, spaces: [space] };

describe("cuaSpaceInventory", () => {
  it.effect("decodes native managed inventory including unknown current identity", () =>
    Effect.gen(function* () {
      expect((yield* cuaSpaceInventory(inventory)).spaces[0]).toEqual({
        id: 7,
        uuid: "space-uuid",
        displayId: "display-a",
        kind: "desktop",
        current: false,
      });
      const unknown = yield* cuaSpaceInventory({
        ...inventory,
        complete: false,
        spaces: [{ ...space, current: null, space_uuid: null }],
      });
      expect(unknown.spaces[0]?.current).toBeNull();
    }),
  );

  it.effect.each([
    { windows: [{ space_ids: [7] }] },
    { ...inventory, spaces: [{ ...space, space_id: 1.5 }] },
    { ...inventory, spaces: [{ ...space, space_id: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...inventory, spaces: [{ ...space, display_id: "" }] },
    { ...inventory, spaces: [space, { ...space, space_uuid: "other" }] },
    { ...inventory, spaces: [space, { ...space, space_id: 8 }] },
  ])("rejects guessed, malformed and ambiguous inventory", (value) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(cuaSpaceInventory(value));
      expect(error.code).toBe("computer_spaces_unavailable");
    }),
  );
});
