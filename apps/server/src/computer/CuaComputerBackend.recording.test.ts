import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { idleWorkflowRecording, ProviderDriverKind } from "@spiritdevs/contracts";
import { makeCuaComputerBackend } from "./CuaComputerBackend.ts";
import { ComputerManager } from "./ComputerManager.ts";
import { fakeCuaRequest } from "./testing/FakeCuaRequest.ts";
import { makeWorkflowRecordingTools } from "../mcp/toolkits/computer/workflowRecordingTools.ts";
import type { ToolContext } from "../mcp/toolkits/computer/toolRuntime.ts";

describe("recording transport and agent ownership", () => {
  it.effect("supplies one canonical skill prompt to every client", () =>
    Effect.gen(function* () {
      const backend = yield* makeCuaComputerBackend({
        endpoint: "/fixture/socket",
        request: fakeCuaRequest(async () => ({
          ok: true,
          result: {
            ...idleWorkflowRecording(true),
            phase: "completed",
            eventsPath: "/private/fixture/events.jsonl",
            metadataPath: "/private/fixture/session.json",
          },
        })),
      });
      const manager = yield* ComputerManager.make({ backend });
      const result = yield* manager.recordWorkflow("status", "owner");
      expect(result.skillPrompt).toContain("/private/fixture/events.jsonl");
      expect(result.skillPrompt).toContain("Create a reusable skill");
      expect(result.skillPrompt).toContain("SKILL.md");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("forwards local host authority and binds tools to the caller thread", () =>
    Effect.gen(function* () {
      const requests: unknown[] = [];
      const backend = yield* makeCuaComputerBackend({
        endpoint: "/fixture/host.socket",
        capability: "fixture-authority",
        request: fakeCuaRequest(async (_, body) => {
          requests.push(body);
          return { ok: true, result: idleWorkflowRecording(true) };
        }),
      });
      const manager = yield* ComputerManager.make({ backend });
      const tools = makeWorkflowRecordingTools(manager);
      const context: ToolContext = {
        callerThreadId: "owner",
        callerThreadLabel: null,
        callerSessionKey: "session",
        callerProvider: ProviderDriverKind.make("codex"),
        callerCapabilities: new Set(["computer"]),
        callerTurnId: "turn",
        assertCallerTurnActive: () => Effect.void,
        jsonRpcRequestId: 1,
      };
      for (const tool of tools) expect((yield* tool.handler({}, context)).isError).toBeUndefined();
      expect(requests).toEqual(
        ["status", "start", "stop", "cancel"].map((action) => ({
          method: "workflow_recording",
          action,
          task: { threadId: "owner" },
          capability: "fixture-authority",
        })),
      );
      expect((yield* tools[0]!.handler({ threadId: "other" }, context)).isError).toBe(true);
      expect(requests).toHaveLength(4);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
