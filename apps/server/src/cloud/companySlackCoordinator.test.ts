// @effect-diagnostics globalDate:off globalDateInEffect:off globalErrorInEffectFailure:off anyUnknownInErrorContext:off -- Deterministic fakes use a fixed process clock and deliberately erase adapter errors.
import { describe, expect, it } from "@effect/vitest";
import { CompanyId } from "@spiritdevs/contracts/company";
import { EnvironmentId } from "@spiritdevs/contracts";
import { ConvexError } from "convex/values";
import * as Effect from "effect/Effect";

import type { SlackApiClientShape } from "../issues/slack/SlackApiClient.ts";
import {
  isCompanySlackWorkspaceOwned,
  removeCompanyOwnedSlackWorkspaces,
} from "./companyIntegrationActivation.ts";
import {
  isAutomationPermissionRefusal,
  runCompanySlackCycle,
  type CompanySlackBackend,
  type CompanySlackRuntime,
} from "./companySlackCoordinator.ts";

describe("company Slack coordinator", () => {
  it.effect("keeps separate company routing when Slack cycles run together", () =>
    Effect.gen(function* () {
      const observed: string[] = [];
      const protocolVersions: number[] = [];
      const backend = {
        publishCapabilities: ({
          companyId,
          slackProtocolVersion,
        }: {
          companyId: string;
          slackProtocolVersion: number;
        }) =>
          Effect.sync(() => {
            observed.push(`capabilities:${companyId}`);
            protocolVersions.push(slackProtocolVersion);
          }),
        listIntegrations: (companyId: string) =>
          Effect.sync(() => {
            observed.push(`integrations:${companyId}`);
            return [];
          }),
        ownedWorkspaceIds: (companyId: string) => Effect.succeed([`workspace-${companyId}`]),
      } as unknown as CompanySlackBackend;
      const runtime = (companyId: string): CompanySlackRuntime => ({
        companyId: CompanyId.make(companyId),
        environmentId: EnvironmentId.make("shared-environment"),
        backend,
        slack: {} as SlackApiClientShape,
        providers: [],
        now: Date.now,
      });

      yield* Effect.all(
        [runCompanySlackCycle(runtime("company-a")), runCompanySlackCycle(runtime("company-b"))],
        { concurrency: "unbounded" },
      );

      expect(observed.toSorted()).toEqual([
        "capabilities:company-a",
        "capabilities:company-b",
        "integrations:company-a",
        "integrations:company-b",
      ]);
      expect(protocolVersions).toEqual([2, 2]);
      expect(isCompanySlackWorkspaceOwned("workspace-company-a")).toBe(true);
      expect(isCompanySlackWorkspaceOwned("workspace-company-b")).toBe(true);
      removeCompanyOwnedSlackWorkspaces("company-a");
      removeCompanyOwnedSlackWorkspaces("company-b");
    }),
  );

  it.effect(
    "lets two eligible environments observe one origin but only the lease holder file and confirm it",
    () =>
      Effect.gen(function* () {
        let createdIssueId: string | null = null;
        let createCalls = 0;
        let createInput: Record<string, unknown> | null = null;
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
          listDueMessages: () => Effect.succeed([]),
          readCursor: () =>
            Effect.succeed({ messageCursor: "1.000000", reactionCursor: "1.000000" }),
          updateCursor: () => Effect.void,
          createIssue: (input: Record<string, unknown>) =>
            Effect.sync(() => {
              createCalls += 1;
              createInput = input;
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

        yield* runCompanySlackCycle(runtime("primary"));
        yield* runCompanySlackCycle(runtime("backup"));

        expect(createCalls).toBe(1);
        expect(createInput).not.toHaveProperty("ruleId");
        expect(createInput).not.toHaveProperty("watchRevision");
        expect(createdIssueId).toBe("issue-1");
        expect(confirmations).toBe(1);
        expect(completeAttempts).toBe(2);
        expect(pendingConfirmation).toBeNull();
      }),
  );

  it.effect("routes V2 watches with their rule identity and normalized title", () =>
    Effect.gen(function* () {
      const now = 1_700_000_120_000;
      const createInputs: Array<Record<string, unknown>> = [];
      const ignoredReasons: string[] = [];
      const cursorUpdates: Array<Record<string, unknown>> = [];
      const integration = {
        id: "integration-v2",
        workspaceId: "T123",
        state: "active" as const,
        preferredEnvironmentId: "primary",
        backupEnvironmentIds: [],
      };
      const backend = {
        publishCapabilities: () => Effect.void,
        listIntegrations: () => Effect.succeed([integration]),
        ownedWorkspaceIds: () => Effect.succeed([integration.workspaceId]),
        heartbeat: () =>
          Effect.succeed({
            integrationId: integration.id,
            holderEnvironmentId: "primary",
            generation: 1,
            expiresAt: now + 90_000,
          }),
        credential: () => Effect.succeed({ workspaceId: "T123", token: "memory-only-token" }),
        configuration: () =>
          Effect.succeed({
            integration,
            watches: [
              {
                id: "watch-v2",
                companyId: "company-1",
                integrationId: integration.id,
                channelId: "C123",
                channelName: "triage",
                configurationVersion: 2,
                rules: [
                  {
                    id: "rule-bug",
                    name: "Bug reports",
                    condition: { kind: "text-prefix", prefixes: ["bug:", "bug: urgent"] },
                    teamId: null,
                    cloudProjectId: null,
                    cycleId: null,
                    initialStatusId: null,
                    investigation: {
                      timing: "off",
                      triggerStatusId: null,
                      successStatusId: null,
                    },
                    assignmentTiming: "off",
                  },
                ],
                revision: 7,
                createdAt: now,
                updatedAt: now,
              },
            ],
          }),
        listDueMessages: () => Effect.succeed([]),
        clearDeferredMessage: () => Effect.void,
        readCursor: () =>
          Effect.succeed({ messageCursor: "1699999999.000000", reactionCursor: null }),
        updateCursor: (input: Record<string, unknown>) =>
          Effect.sync(() => {
            cursorUpdates.push(input);
          }),
        createIssue: (input: Record<string, unknown>) =>
          Effect.sync(() => {
            createInputs.push(input);
            return { created: false, issueId: "issue-1", issueKey: "ACM-1" };
          }),
        recordIgnored: ({ reason }: { reason: string }) =>
          Effect.sync(() => {
            ignoredReasons.push(reason);
          }),
        threadsForReplyScan: () => Effect.succeed([]),
        pendingDeliveries: () => Effect.succeed([]),
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
            messages: [
              { ts: "1700000000.000000", user: "U1", text: "  BUG: urgent Login fails" },
              { ts: "1700000001.000000", user: "U1", text: "A normal message" },
            ],
            hasMore: false,
            nextCursor: null,
          }),
        permalink: () => Effect.succeed("https://acme.slack.com/archives/C123/p1"),
        displayName: () => Effect.succeed("Sam"),
      } as unknown as SlackApiClientShape;
      const runtime: CompanySlackRuntime = {
        companyId: CompanyId.make("company-1"),
        environmentId: EnvironmentId.make("primary"),
        backend,
        slack,
        providers: [],
        now: () => now,
      };

      yield* runCompanySlackCycle(runtime);

      expect(createInputs).toHaveLength(1);
      expect(createInputs[0]).toMatchObject({
        ruleId: "rule-bug",
        watchRevision: 7,
        routeEmoji: null,
        title: "Login fails",
        description: "**Slack comment:**\n\n  BUG: urgent Login fails",
      });
      expect(ignoredReasons).toEqual(["no-rule"]);
      expect(cursorUpdates[0]).toMatchObject({ messageCursor: "1700000001.000000" });
    }),
  );

  it.effect("stores reaction grace durably and refetches the message when due", () =>
    Effect.gen(function* () {
      let now = 1_700_000_030_000;
      let createCalls = 0;
      let ignoredCalls = 0;
      let deferredCalls = 0;
      let clearedCalls = 0;
      let savedMessageCursor: string | null = "1699999999.000000";
      let pending: {
        readonly channelId: string;
        readonly messageTs: string;
        readonly watchRevision: number;
        readonly candidateRuleId: string;
        readonly eligibleAt: number;
      } | null = null;
      const integration = {
        id: "integration-v2",
        workspaceId: "T123",
        state: "active" as const,
        preferredEnvironmentId: "primary",
        backupEnvironmentIds: [],
      };
      const ruleDefaults = {
        teamId: null,
        cloudProjectId: null,
        cycleId: null,
        initialStatusId: null,
        investigation: {
          timing: "off" as const,
          triggerStatusId: null,
          successStatusId: null,
        },
        assignmentTiming: "off" as const,
      };
      const backend = {
        publishCapabilities: () => Effect.void,
        listIntegrations: () => Effect.succeed([integration]),
        ownedWorkspaceIds: () => Effect.succeed([integration.workspaceId]),
        heartbeat: () =>
          Effect.succeed({
            integrationId: integration.id,
            holderEnvironmentId: "primary",
            generation: 1,
            expiresAt: now + 90_000,
          }),
        credential: () => Effect.succeed({ workspaceId: "T123", token: "memory-only-token" }),
        configuration: () =>
          Effect.succeed({
            integration,
            watches: [
              {
                id: "watch-v2",
                companyId: "company-1",
                integrationId: integration.id,
                channelId: "C123",
                channelName: "triage",
                configurationVersion: 2,
                rules: [
                  {
                    id: "rule-eyes",
                    name: "Needs eyes",
                    condition: { kind: "reaction", emoji: "eyes" },
                    ...ruleDefaults,
                  },
                  {
                    id: "rule-fallback",
                    name: "Fallback",
                    condition: { kind: "every-message" },
                    ...ruleDefaults,
                  },
                ],
                revision: 8,
                createdAt: now,
                updatedAt: now,
              },
            ],
          }),
        listDueMessages: () =>
          Effect.succeed(pending !== null && pending.eligibleAt <= now ? [pending] : []),
        deferMessage: () =>
          Effect.sync(() => {
            deferredCalls += 1;
            pending = {
              channelId: "C123",
              messageTs: "1700000000.000000",
              watchRevision: 8,
              candidateRuleId: "rule-fallback",
              eligibleAt: now + 30_000,
            };
            return pending;
          }),
        clearDeferredMessage: () =>
          Effect.sync(() => {
            clearedCalls += 1;
            pending = null;
          }),
        readCursor: () =>
          Effect.sync(() => ({ messageCursor: savedMessageCursor, reactionCursor: null })),
        updateCursor: ({ messageCursor }: { messageCursor: string | null }) =>
          Effect.sync(() => {
            savedMessageCursor = messageCursor;
          }),
        createIssue: () =>
          Effect.sync(() => {
            createCalls += 1;
            return { created: false, issueId: "issue-1", issueKey: "ACM-1" };
          }),
        recordIgnored: () =>
          Effect.sync(() => {
            ignoredCalls += 1;
          }),
        threadsForReplyScan: () => Effect.succeed([]),
        pendingDeliveries: () => Effect.succeed([]),
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
            messages:
              now < 1_700_000_060_000
                ? [{ ts: "1700000000.000000", username: "Sam", text: "Fallback later" }]
                : [],
            hasMore: false,
            nextCursor: null,
          }),
        replies: () =>
          Effect.succeed([{ ts: "1700000000.000000", username: "Sam", text: "Fallback later" }]),
        permalink: () => Effect.succeed("https://acme.slack.com/archives/C123/p1"),
      } as unknown as SlackApiClientShape;

      yield* runCompanySlackCycle({
        companyId: CompanyId.make("company-1"),
        environmentId: EnvironmentId.make("primary"),
        backend,
        slack,
        providers: [],
        now: () => now,
      });

      expect(createCalls).toBe(0);
      expect(ignoredCalls).toBe(0);
      expect(deferredCalls).toBe(1);
      expect(savedMessageCursor).toBe("1700000000.000000");

      now = 1_700_000_090_000;
      yield* runCompanySlackCycle({
        companyId: CompanyId.make("company-1"),
        environmentId: EnvironmentId.make("primary"),
        backend,
        slack,
        providers: [],
        now: () => now,
      });

      expect(createCalls).toBe(1);
      expect(clearedCalls).toBe(1);
      expect(pending).toBeNull();
    }),
  );

  it("pauses automation polling only for the typed permission refusal", () => {
    expect(
      isAutomationPermissionRefusal(
        new ConvexError({ code: "permission-denied", message: "Missing permission." }),
      ),
    ).toBe(true);
    expect(
      isAutomationPermissionRefusal(
        new ConvexError({ code: "entity-not-found", message: "Missing row." }),
      ),
    ).toBe(false);
    expect(isAutomationPermissionRefusal(new Error("fetch failed"))).toBe(false);
    expect(isAutomationPermissionRefusal(null)).toBe(false);
  });
});
