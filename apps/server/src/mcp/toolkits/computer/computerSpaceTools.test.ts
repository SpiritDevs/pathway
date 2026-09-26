import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import { ProviderDriverKind, type ComputerSpaceInventory } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ComputerApprovalOutcome } from "../../../computer/ComputerApprovalGate.ts";
import { ComputerManager } from "../../../computer/ComputerManager.ts";
import { FakeComputerBackend } from "../../../computer/FakeComputerBackend.ts";
import { makeComputerTools } from "./computerTools.ts";
import type { McpToolCallResult, ToolContext } from "./toolRuntime.ts";

const inventory: ComputerSpaceInventory = {
  source: "macos-managed-spaces",
  complete: true,
  spaces: [{ id: 2, uuid: "uuid-2", displayId: "display-a", kind: "desktop", current: false }],
};

function context(): ToolContext {
  return {
    callerThreadId: "a",
    callerThreadLabel: "Fixture",
    callerSessionKey: "session",
    callerProvider: ProviderDriverKind.make("claudeAgent"),
    callerCapabilities: new Set(["computer"]),
    callerTurnId: "turn",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function text(result: McpToolCallResult): string {
  const part = result.content.find((c) => c.type === "text");
  return part?.type === "text" ? part.text : "";
}

function json(result: McpToolCallResult): Record<string, unknown> {
  const raw = text(result);
  return raw === "" ? {} : (decodeJson(raw) as Record<string, unknown>);
}

const setup = Effect.fn(function* (
  designate = vi.fn((): Effect.Effect<readonly number[]> => Effect.succeed([2])),
) {
  const backend = Object.assign(new FakeComputerBackend(), {
    listSpaces: vi.fn(() => Effect.succeed(inventory)),
  });
  const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
  const authorizeAction = vi.fn(() => Effect.succeed<ComputerApprovalOutcome>("approved"));
  const entries = makeComputerTools({
    manager,
    resolveSpaceDesignation: designate,
    authorizeAction,
  });
  const call = (name: string, args: Record<string, unknown>) =>
    entries.find((e) => e.definition.name === name)!.handler(args, context());
  const inspect = (args: Record<string, unknown>) =>
    call("computer_inspect", { tool: "computer_spaces", arguments: args });
  return { manager, backend, entries, call, inspect, designate, authorizeAction };
});

it.layer(NodeServices.layer)("computer_spaces", (it) => {
  describe("discoverable computer_spaces gateway", () => {
    it.effect("has a real inspect/help route and adds no advertised tool", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { entries, call, inspect } = yield* setup();
          expect(entries.find((e) => e.definition.name === "computer_spaces")?.discoveryOnly).toBe(
            true,
          );
          const help = yield* call("computer_help", { tool: "computer_spaces" });
          expect(text(help)).toContain("computer_inspect");
          const result = yield* inspect({ operation: "list" });
          expect(result.isError).not.toBe(true);
          expect(json(result)).toMatchObject({
            inventory,
            reservation: null,
            changedDesktop: false,
          });
        }),
      ),
    );

    it.effect("reserves only after fresh user designation, without repeated desktop approval", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { inspect, designate, authorizeAction } = yield* setup();
          const result = yield* inspect({ operation: "reserve", space_id: 2 });
          expect(result.isError).not.toBe(true);
          expect(json(result)).toMatchObject({
            reservation: { spaceId: 2 },
            changedDesktop: false,
          });
          expect(text(result)).not.toContain('"threadId"');
          expect(text(result)).not.toContain('"turnId"');
          expect(designate).toHaveBeenCalledTimes(2);
          expect(authorizeAction).not.toHaveBeenCalled();
        }),
      ),
    );

    it.effect(
      "full access cannot invent user designation and late revocation prevents commit",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { inspect, manager, designate } = yield* setup(
              vi.fn((): Effect.Effect<readonly number[]> => Effect.succeed([])),
            );
            const denied = yield* inspect({ operation: "reserve", space_id: 2 });
            expect(json(denied)).toMatchObject({
              error: { code: "computer_space_not_designated" },
            });
            designate
              .mockReturnValueOnce(Effect.succeed([2]))
              .mockReturnValueOnce(Effect.succeed([]));
            const revoked = yield* inspect({ operation: "reserve", space_id: 2 });
            expect(json(revoked)).toMatchObject({
              error: { code: "computer_space_not_designated" },
            });
            expect(
              manager.spaceBroker.reservationFor({ threadId: "a", turnId: "turn" }),
            ).toBeNull();
          }),
        ),
    );

    it.effect.each(["create", "move", "switch", "follow"])(
      "%s is an honest refusal without native calls",
      (operation) =>
        Effect.scoped(
          Effect.gen(function* () {
            const { inspect, backend } = yield* setup();
            expect(json(yield* inspect({ operation }))).toMatchObject({
              error: { code: "computer_space_operation_unsupported" },
            });
            expect(backend.listSpaces).not.toHaveBeenCalled();
            expect(backend.callsFor("raiseWindow")).toHaveLength(0);
          }),
        ),
    );

    it.effect("validates inspect arguments using the canonical schema", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { inspect } = yield* setup();
          expect(
            (yield* inspect({ operation: "reserve", space_id: 2, user_designated: true })).isError,
          ).toBe(true);
          expect((yield* inspect({ operation: "reserve", space_id: 2.1 })).isError).toBe(true);
        }),
      ),
    );
  });
});
