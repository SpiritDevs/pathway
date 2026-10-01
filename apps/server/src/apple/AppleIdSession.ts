import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AppleError, type AppleIdSessionState } from "@spiritdevs/contracts/apple";

/** COR-101 owns the interactive protocol, challenge fan-out and sealed, expiring account session leases.
 * This stub accepts no password or code storage and creates no Apple session.
 */
export const appleIdSessionStub = {
  // TODO(COR-101): create the ASC app using the authenticated Apple ID web session.
  createApp: Effect.fail(
    new AppleError({
      code: "not-implemented",
      message: "App creation requires the Apple ID session service planned for COR-101.",
      retryAfterSeconds: null,
    }),
  ),
  status: Effect.succeed({ state: "signed-out" } satisfies typeof AppleIdSessionState.Type),
  unavailable: Effect.fail(
    new AppleError({
      code: "not-implemented",
      message: "Interactive Apple ID sign-in is planned for COR-101.",
      retryAfterSeconds: null,
    }),
  ),
  changes: Stream.make({ state: "signed-out" } satisfies typeof AppleIdSessionState.Type),
};
