import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { COMPUTER_PROVISION_SUMMARY_MAX_LENGTH } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";

import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";

/** A fake that actually offers setup, returning the scripted provision transcript. */
class ProvisioningFakeBackend extends FakeComputerBackend {
  provisionCalls = 0;
  private readonly transcript: string;
  constructor(transcript: string) {
    super();
    this.transcript = transcript;
  }

  provision(): Effect.Effect<string> {
    return Effect.sync(() => {
      this.provisionCalls += 1;
      return this.transcript;
    });
  }
}

it.layer(NodeServices.layer)("computer provision", (it) => {
  it.effect("engages the backend first, so setup reads the live desktop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new ProvisioningFakeBackend("Computer permissions are ready.");
        const manager = yield* ComputerManager.make({ backend });
        yield* manager.provision();
        // Engaged means the establishing read, never the passive probe.
        expect(backend.callsFor("availability").length).toBeGreaterThan(0);
        expect(backend.callsFor("probeAvailability")).toHaveLength(0);
        expect(backend.provisionCalls).toBe(1);
      }),
    ),
  );

  it.effect("throws without provisioning when the backend has nothing to install", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend });
        const error = yield* Effect.flip(manager.provision());
        expect(error.message).toContain("nothing to install");
        expect((yield* manager.getStatus()).provisionable).toBe(false);
      }),
    ),
  );

  it.effect("clamps the transcript and answers with the post-setup status", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new ProvisioningFakeBackend("L".repeat(100_000));
        const manager = yield* ComputerManager.make({ backend });
        const result = yield* manager.provision();
        expect(result.summary).toHaveLength(COMPUTER_PROVISION_SUMMARY_MAX_LENGTH);
        expect(result.status.computerId).toBe("desktop");
        expect(result.status.availability).toEqual({ kind: "available", backend: "fake" });
        expect(result.status.health.status).toBe("connected");
        expect(result.status.capabilities.input).toBe(true);
        expect(result.status.provisionable).toBe(true);
      }),
    ),
  );
});
