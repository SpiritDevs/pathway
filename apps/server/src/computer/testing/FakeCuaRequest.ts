import { CuaTransportError } from "@spiritdevs/shared/cuaDriverProtocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { CuaRequest } from "../CuaComputerBackend.ts";

const isCuaTransportError = Schema.is(CuaTransportError);

/**
 * Puts a Promise-shaped fake Cua driver behind the Effect `cuaRequest` seam.
 * A thrown error gets the verdict the socket client gives a failed exchange,
 * and `aborted` collects every request whose caller interrupted it.
 */
export const fakeCuaRequest =
  (
    respond: (
      endpoint: string,
      body: unknown,
      options?: Parameters<CuaRequest>[2],
    ) => Promise<unknown>,
    aborted?: unknown[],
  ): CuaRequest =>
  (endpoint, body, options) =>
    Effect.tryPromise({
      try: () => respond(endpoint, body, options),
      catch: (error) =>
        isCuaTransportError(error)
          ? error
          : new CuaTransportError({
              message: error instanceof Error ? error.message : String(error),
              effect: options?.mutation ? "dispatched-unknown" : "not-dispatched",
            }),
    }).pipe(Effect.onInterrupt(() => Effect.sync(() => aborted?.push(body))));
