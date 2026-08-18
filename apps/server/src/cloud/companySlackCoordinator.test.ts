// @effect-diagnostics globalDate:off globalDateInEffect:off globalErrorInEffectFailure:off anyUnknownInErrorContext:off -- Deterministic fakes use a fixed process clock and deliberately erase adapter errors.
import { CompanyId } from "@spiritdevs/contracts/company";
import { EnvironmentId } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import type { SlackApiClientShape } from "../issues/slack/SlackApiClient.ts";
import {
  runCompanySlackCycle,
  type CompanySlackBackend,
  type CompanySlackRuntime,
} from "./companySlackCoordinator.ts";

describe("company Slack coordinator", () => {
  it("lets two eligible environments observe one origin but only the lease holder file and confirm it", async () => {
    let createdIssueId: string | null = null;
    let createCalls = 0;
    let confirmations = 0;
    let completeAttempts = 0;
    let pendingConfirmation: {
      deliveryId: string;
      channelId: string;
      threadTs: string;
      kind: "confirmation";
      text: string;
    } | null = null;
    const integration = {
      id: "integration-1",
      workspaceId: "T123",
      workspaceName: "Acme",
      workspaceDomain: "acme",
      botUserId: "U-BOT",
      botId: "B-BOT",
      state: "active" as const,
      activatedAt: Date.now(),
      credentialPresent: true,
      preferredEnvironmentId: "primary",
      backupEnvironmentIds: ["backup"],
      configurationRevision: 1,
      controllerEnvironmentId: "primary",
      leaseGeneration: 1,
      leaseExpiresAt: Date.now() + 90_000,
      lastPollAt: null,
      currentError: null,
      blockedReason: null,
      healthHistory: [],
      watchCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const backend = {
      publishCapabilities: () => Effect.void,
      listIntegrations: () => Effect.succeed([integration]),
      ownedWorkspaceIds: () => Effect.succeed([integration.workspaceId]),
      automationSettings: () => Effect.succeed(null),
      heartbeat: ({
        integrationId,
        companyId: _companyId,
      }: {
        integrationId: string;
        companyId: string;
      }) =>
        Effect.succeed({
          integrationId,
          holderEnvironmentId: "primary",
          generation: 1,
          expiresAt: Date.now() + 90_000,
        }),
      credential: () => Effect.succeed({ workspaceId: "T123", token: "memory-only-token" }),
      configuration: () =>
        Effect.succeed({
          integration,
          watches: [
            {
              id: "watch-1",
              integrationId: integration.id,
              channelId: "C123",
              channelName: "triage",
              cloudProjectId: null,
              cycleId: null,
              autoInvestigate: false,
              autoAssign: false,
              trigger: { everyMessage: true, botMention: false, reactionRoutes: [] },
              revision: 1,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ],
        }),
      readCursor: () => Effect.succeed({ messageCursor: "1.000000", reactionCursor: "1.000000" }),
      updateCursor: () => Effect.void,
      createIssue: () =>
        Effect.sync(() => {
          createCalls += 1;
          if (createdIssueId !== null) {
            return { created: false, issueId: createdIssueId, issueKey: "ACM-1" };
          }
          createdIssueId = "issue-1";
          return { created: true, issueId: createdIssueId, issueKey: "ACM-1" };
        }),
      threadsForReplyScan: () => Effect.succeed([]),
      pendingDeliveries: () =>
        Effect.succeed(pendingConfirmation === null ? [] : [pendingConfirmation]),
      claimDelivery: (input: {
        deliveryId: string;
        channelId: string;
        threadTs: string;
        kind: "confirmation" | "comment" | "status";
        text?: string;
      }) =>
        Effect.sync(() => {
          if (input.kind === "confirmation" && input.text !== undefined) {
            pendingConfirmation = {
              deliveryId: input.deliveryId,
              channelId: input.channelId,
              threadTs: input.threadTs,
              kind: "confirmation",
              text: input.text,
            };
          }
          return {
            deliveryId: input.deliveryId,
            state: "claimed" as const,
            claimGeneration: completeAttempts + 1,
            claimExpiresAt: Date.now() + 90_000,
            slackMessageTs: null,
          };
        }),
      completeDelivery: () =>
        Effect.suspend(() => {
          completeAttempts += 1;
          if (completeAttempts === 1) return Effect.fail(new Error("ambiguous network result"));
          pendingConfirmation = null;
          return Effect.void;
        }),
      updateHealth: () => Effect.void,
    } as unknown as CompanySlackBackend;
    const slack = {
      authTest: () =>
        Effect.succeed({
          workspaceId: "T123",
          workspaceName: "Acme",
          workspaceDomain: "acme",
          botUserId: "U-BOT",
          botId: "B-BOT",
        }),
      history: () =>
        Effect.succeed({
          messages: [{ ts: "2.000000", user: "U1", text: "Create one issue" }],
          hasMore: false,
          nextCursor: null,
        }),
      replies: () =>
        Effect.succeed(
          confirmations === 0
            ? []
            : [
                {
                  ts: "2.000001",
                  bot_id: "B-BOT",
                  metadata: {
                    event_type: "pathway_delivery",
                    event_payload: { delivery_id: "slack-confirmation-issue-1" },
                  },
                },
              ],
        ),
      permalink: () => Effect.succeed("https://acme.slack.com/archives/C123/p2"),
      displayName: () => Effect.succeed("Sam"),
      postToThread: () =>
        Effect.sync(() => {
          confirmations += 1;
          return { messageTs: "2.000001" };
        }),
    } as unknown as SlackApiClientShape;
    const runtime = (environmentId: string): CompanySlackRuntime => ({
      companyId: CompanyId.make("company-1"),
      environmentId: EnvironmentId.make(environmentId),
      backend,
      slack,
      providers: [],
      now: Date.now,
    });

    await Effect.runPromise(runCompanySlackCycle(runtime("primary")));
    await Effect.runPromise(runCompanySlackCycle(runtime("backup")));

    expect(createCalls).toBe(1);
    expect(createdIssueId).toBe("issue-1");
    expect(confirmations).toBe(1);
    expect(completeAttempts).toBe(2);
    expect(pendingConfirmation).toBeNull();
  });
});
