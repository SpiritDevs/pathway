import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../../config.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { ScheduledTaskService } from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../../vcs/VcsStatusBroadcaster.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const StubServicesLive = Layer.mergeAll(
  Layer.mock(ThreadManagementService)({}),
  Layer.mock(ProviderRegistry)({}),
  Layer.mock(ScheduledTaskService)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  ServerSettings.layerTest({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster)({}),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-worktree-mcp-test-" }),
  PreviewAutomationBroker.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

const invocation: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-scratch"),
  threadId: ThreadId.make("thread-scratch"),
  providerSessionId: "worktree-registration-test",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  providerDriverKind: ProviderDriverKind.make("claude"),
  capabilities: new Set(["worktree"]),
  issuedAt: 1,
};

it.effect("lists worktree tools through the v2 client", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const handler = yield* McpHttpServer.makeCoreToolkitsTestHandler;
      const client = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const connected = new Client(
            { name: "worktree-mcp-test", version: "1.0.0" },
            {
              capabilities: {},
              versionNegotiation: { mode: { pin: McpHttpServer.MCP_PROTOCOL_VERSION } },
            },
          );
          await connected.connect(
            new StreamableHTTPClientTransport(new URL("http://pathway.test/mcp"), {
              fetch: (input, init) =>
                handler.fetch(
                  new Request(typeof input === "string" ? input : input.href, init),
                  invocation,
                ),
            }),
          );
          return connected;
        }),
        (connected) => Effect.promise(() => connected.close()).pipe(Effect.orDie),
      );
      const tools = (yield* Effect.promise(() => client.listTools())).tools;
      const toolNames = tools.map(({ name }) => name);
      expect(toolNames).toContain("t3_worktree_handoff");
      expect(toolNames).toContain("t3_worktree_status");
      expect(toolNames).toContain("preview_status");
      expect(toolNames).toContain("delegate_task");

      const handoff = tools.find(({ name }) => name === "t3_worktree_handoff");
      expect(handoff?.annotations?.readOnlyHint).toBe(false);
      expect(handoff?.annotations?.destructiveHint).toBe(true);
      expect(handoff?.annotations?.openWorldHint).toBe(true);
      const status = tools.find(({ name }) => name === "t3_worktree_status");
      expect(status?.annotations?.readOnlyHint).toBe(true);
      expect(status?.annotations?.destructiveHint).toBe(false);

      for (const tool of tools) {
        expect(tool.inputSchema.type, `inputSchema.type of ${tool.name}`).toBe("object");
      }
    }),
  ).pipe(Effect.provide(StubServicesLive)),
);
