/**
 * Decodes the Cua driver's managed-display Space inventory.
 *
 * @module computer/cuaSpaceInventory
 */
import { type ComputerSpace, ComputerSpaceInventory } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { ComputerSpaceError } from "./computerErrors.ts";

const unavailable = () =>
  new ComputerSpaceError(
    "computer_spaces_unavailable",
    "The native driver did not provide a valid managed-display Space inventory. Use exact existing windows in place; do not infer empty Spaces or Space ownership from window membership.",
  );

function hasDuplicateIdentity(spaces: readonly ComputerSpace[]): boolean {
  const ids = new Set<number>();
  const uuids = new Set<string>();
  for (const space of spaces) {
    if (ids.has(space.id) || (space.uuid !== null && uuids.has(space.uuid))) return true;
    ids.add(space.id);
    if (space.uuid !== null) uuids.add(space.uuid);
  }
  return false;
}

const decodeInventory = Schema.decodeUnknownEffect(ComputerSpaceInventory);

/** Decode only the native managed-display inventory; window membership is not a substitute. */
export const cuaSpaceInventory = (
  value: Record<string, unknown>,
): Effect.Effect<ComputerSpaceInventory, ComputerSpaceError> =>
  Effect.suspend(() => {
    const entries = value.spaces;
    if (value.source !== "macos-managed-spaces" || !Array.isArray(entries)) {
      return Effect.fail(unavailable());
    }
    if (!entries.every((entry) => Predicate.isObject(entry) && !Array.isArray(entry))) {
      return Effect.fail(unavailable());
    }
    return decodeInventory({
      source: value.source,
      complete: value.complete,
      spaces: entries.map((space: Record<string, unknown>) => ({
        id: space.space_id,
        uuid: space.space_uuid,
        displayId: space.display_id,
        kind: space.kind,
        current: space.current,
      })),
    }).pipe(
      Effect.mapError(unavailable),
      Effect.filterOrFail((inventory) => !hasDuplicateIdentity(inventory.spaces), unavailable),
    );
  });
