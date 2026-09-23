import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import { ProviderDriverKind } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ComputerApprovalOutcome } from "../../../computer/ComputerApprovalGate.ts";
import { ComputerManager } from "../../../computer/ComputerManager.ts";
import { FakeComputerBackend } from "../../../computer/FakeComputerBackend.ts";
import { makeComputerTools, type ComputerToolsOptions } from "./computerTools.ts";
import type { McpToolCallResult, ToolContext } from "./toolRuntime.ts";

function context(): ToolContext {
  return {
    callerThreadId: "thread-smoke",
    callerThreadLabel: "Smoke",
    callerSessionKey: "mcp-session:smoke",
    callerProvider: ProviderDriverKind.make("claudeAgent"),
    callerCapabilities: new Set(["computer"]),
    callerTurnId: "turn-smoke",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function textOf(result: McpToolCallResult): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

const setup = Effect.fn(function* (authorizeAction?: ComputerToolsOptions["authorizeAction"]) {
  const backend = new FakeComputerBackend();
  const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
  const entries = makeComputerTools({ manager, ...(authorizeAction ? { authorizeAction } : {}) });
  const call = (name: string, args: Record<string, unknown>) =>
    entries.find((entry) => entry.definition.name === name)!.handler(args, context());
  return { backend, entries, call };
});

it.layer(NodeServices.layer)("computerTools smoke", (it) => {
  it.effect("lists a unique catalog and withholds discovery-only tools from tools/list", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { entries, call } = yield* setup();
        const names = entries.map((entry) => entry.definition.name);
        expect(new Set(names).size).toBe(names.length);
        expect(names.every((name) => name.startsWith("computer_"))).toBe(true);
        const advertised = entries
          .filter((entry) => entry.discoveryOnly !== true)
          .map((entry) => entry.definition.name);
        expect(advertised).toEqual(
          expect.arrayContaining(["computer_screenshot", "computer_help", "computer_inspect"]),
        );
        expect(advertised).not.toContain("computer_write_clipboard");
        expect(advertised).not.toContain("computer_spaces");
        // Discovery-only is not hidden from help: the schema is still readable.
        const help = decodeJson(
          textOf(yield* call("computer_help", { tool: "computer_write_clipboard" })),
        );
        expect(help).toMatchObject({
          definition: { name: "computer_write_clipboard" },
          advertised: false,
        });
      }),
    ),
  );

  it.effect("a read tool answers from the backend without asking for approval", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const authorizeAction = vi.fn(() => Effect.succeed<ComputerApprovalOutcome>("approved"));
        const { call } = yield* setup(authorizeAction);
        const result = yield* call("computer_get_screen_size", {});
        expect(result.isError).not.toBe(true);
        expect(decodeJson(textOf(result))).toMatchObject({
          screenSize: { width: 1_920, height: 1_080 },
        });
        expect(authorizeAction).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect("a gated mutation runs only once approved", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const authorizeAction = vi.fn(() => Effect.succeed<ComputerApprovalOutcome>("approved"));
        const { backend, call } = yield* setup(authorizeAction);
        const result = yield* call("computer_write_clipboard", { text: "hello" });
        expect(result.isError).not.toBe(true);
        expect(authorizeAction).toHaveBeenCalledTimes(1);
        expect(backend.callsFor("writeClipboard")).toHaveLength(1);
      }),
    ),
  );

  it.effect("a denied gated mutation sends no input", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup(() =>
          Effect.succeed<ComputerApprovalOutcome>("denied"),
        );
        const result = yield* call("computer_write_clipboard", { text: "hello" });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain(
          "Computer action was denied or cancelled; no input was sent.",
        );
        expect(backend.callsFor("writeClipboard")).toHaveLength(0);
      }),
    ),
  );

  it.effect("a pending approval is a non-error wait that sends no input", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, call } = yield* setup(() =>
          Effect.succeed<ComputerApprovalOutcome>("pending"),
        );
        const result = yield* call("computer_write_clipboard", { text: "hello" });
        expect(result.isError).not.toBe(true);
        expect(decodeJson(textOf(result))).toMatchObject({
          status: "approval_pending",
          tool: "computer_write_clipboard",
        });
        expect(backend.callsFor("writeClipboard")).toHaveLength(0);
      }),
    ),
  );
});
