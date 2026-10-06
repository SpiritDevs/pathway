import { describe, expect, it } from "@effect/vitest";
import { setManagedRelaySession } from "@spiritdevs/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { awaitConnectionAccountScope, readConnectionAccountScope } from "./accountScope";

describe("connection account scope", () => {
  it.effect("opens no account cache until Clerk has restored the signed-in account", () =>
    Effect.gen(function* () {
      setManagedRelaySession(appAtomRegistry, null);
      let opened = false;
      const waiting = yield* Effect.forkChild(
        awaitConnectionAccountScope().pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              opened = true;
            }),
          ),
        ),
        { startImmediately: true },
      );
      expect(opened).toBe(false);
      expect(readConnectionAccountScope()).toBeNull();
      setManagedRelaySession(appAtomRegistry, {
        accountId: "restored-account",
        readClerkToken: async () => null,
      });
      expect(yield* Fiber.join(waiting)).toBe("restored-account");
      expect(readConnectionAccountScope()).toBe("restored-account");
      setManagedRelaySession(appAtomRegistry, null);
    }),
  );
});
