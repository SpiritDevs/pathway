import {
  SLACK_MAX_CHANNEL_WATCHES,
  SlackChannelWatchId,
  type SlackChannelRef,
  type SlackChannelWatch,
  type SlackIntakeStatus,
  type SlackIntakeTrigger,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  normalizeSlackChannelName,
  normalizeSlackEmojiName,
  PAUSED_SLACK_TRIGGER,
  slackChannelIdError,
  slackConnectionSummary,
  slackEmojiNameError,
  slackTriggerSummary,
  slackWatchLimitError,
  unwatchedSlackChannels,
} from "./slackIntake.logic";

const NOW = "2026-08-12T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function trigger(overrides: Partial<SlackIntakeTrigger> = {}): SlackIntakeTrigger {
  return { ...PAUSED_SLACK_TRIGGER, ...overrides };
}

function watch(id: string, channelId: string, channelName = channelId): SlackChannelWatch {
  return {
    id: SlackChannelWatchId.make(id),
    channelId,
    channelName,
    projectId: null,
    autoInvestigate: false,
    trigger: PAUSED_SLACK_TRIGGER,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function status(overrides: Partial<SlackIntakeStatus> = {}): SlackIntakeStatus {
  return {
    configured: false,
    lastPollAt: null,
    lastError: null,
    workspaceName: null,
    ...overrides,
  };
}

describe("slackTriggerSummary", () => {
  it("reads all three off as paused rather than as broken", () => {
    expect(slackTriggerSummary(PAUSED_SLACK_TRIGGER)).toBe("Paused");
  });

  it("spells the reaction the way Slack does", () => {
    expect(
      slackTriggerSummary(
        trigger({
          reactionRoutes: [{ emoji: "ticket", projectId: null, autoInvestigate: null }],
        }),
      ),
    ).toBe(":ticket:");
    expect(
      slackTriggerSummary(
        trigger({ reactionRoutes: [{ emoji: "+1", projectId: null, autoInvestigate: null }] }),
      ),
    ).toBe(":+1:");
  });

  it("summarizes several reaction routes without overflowing the row", () => {
    expect(
      slackTriggerSummary(
        trigger({
          reactionRoutes: [
            { emoji: "quotecloud", projectId: null, autoInvestigate: null },
            { emoji: "ve", projectId: null, autoInvestigate: false },
          ],
        }),
      ),
    ).toBe("2 reactions");
  });

  it("names each trigger on its own", () => {
    expect(slackTriggerSummary(trigger({ everyMessage: true }))).toBe("Every message");
    expect(slackTriggerSummary(trigger({ botMention: true }))).toBe("Bot mentions");
  });

  it("joins a combination in trigger order", () => {
    const reactionRoutes = [{ emoji: "ticket", projectId: null, autoInvestigate: null }] as const;
    expect(slackTriggerSummary({ reactionRoutes, everyMessage: true, botMention: true })).toBe(
      ":ticket: · Every message · Bot mentions",
    );
    expect(slackTriggerSummary(trigger({ reactionRoutes, botMention: true }))).toBe(
      ":ticket: · Bot mentions",
    );
  });
});

describe("normalizeSlackEmojiName", () => {
  it("strips the colons everybody types and the case nobody means", () => {
    expect(normalizeSlackEmojiName(" :Ticket: ")).toBe("ticket");
    expect(normalizeSlackEmojiName("white_check_mark")).toBe("white_check_mark");
  });

  it("leaves the reaction names that are punctuation intact", () => {
    expect(normalizeSlackEmojiName(":+1:")).toBe("+1");
    expect(normalizeSlackEmojiName("-1")).toBe("-1");
  });
});

describe("slackEmojiNameError", () => {
  it("accepts what the contract's pattern accepts", () => {
    expect(slackEmojiNameError(":ticket:")).toBeNull();
    expect(slackEmojiNameError("+1")).toBeNull();
    expect(slackEmojiNameError("white_check_mark")).toBeNull();
  });

  it("asks for a name rather than refusing an empty field silently", () => {
    expect(slackEmojiNameError("  ")).toContain("Enter a reaction name");
  });

  it("rejects a name Slack could never send", () => {
    expect(slackEmojiNameError("thumbs up")).toContain("lower case");
    expect(slackEmojiNameError("🎫")).toContain("lower case");
  });
});

describe("normalizeSlackChannelName", () => {
  it("drops the hash a person types and the space around it", () => {
    expect(normalizeSlackChannelName(" #design ")).toBe("design");
    expect(normalizeSlackChannelName("design")).toBe("design");
  });
});

describe("slackChannelIdError", () => {
  it("accepts the three shapes Slack mints", () => {
    expect(slackChannelIdError("C0123ABCD")).toBeNull();
    expect(slackChannelIdError("G0123ABCD")).toBeNull();
    expect(slackChannelIdError("D0123ABCD")).toBeNull();
  });

  it("rejects a channel name pasted into the id field", () => {
    expect(slackChannelIdError("#design")).toContain("C0123ABCD");
    expect(slackChannelIdError("design")).toContain("C0123ABCD");
  });

  it("asks for something rather than nothing", () => {
    expect(slackChannelIdError("   ")).toBe("Enter a channel id.");
  });
});

describe("unwatchedSlackChannels", () => {
  const channels: ReadonlyArray<SlackChannelRef> = [
    { id: "C1", name: "design" },
    { id: "C2", name: "support" },
  ];

  it("drops a channel already watched, so the picker cannot offer a conflict", () => {
    expect(unwatchedSlackChannels(channels, [watch("w1", "C1")]).map((c) => c.id)).toEqual(["C2"]);
  });

  it("offers everything when nothing is watched", () => {
    expect(unwatchedSlackChannels(channels, [])).toHaveLength(2);
  });
});

describe("slackWatchLimitError", () => {
  it("allows another channel under the cap", () => {
    expect(slackWatchLimitError([watch("w1", "C1")])).toBeNull();
  });

  it("names the cap once it is reached", () => {
    const watches = Array.from({ length: SLACK_MAX_CHANNEL_WATCHES }, (_, index) =>
      watch(`w${index}`, `C${index}`),
    );
    expect(slackWatchLimitError(watches)).toContain(`${SLACK_MAX_CHANNEL_WATCHES} channels`);
  });
});

describe("slackConnectionSummary", () => {
  it("says nothing is connected when no token is on disk", () => {
    const summary = slackConnectionSummary(status(), NOW_MS);
    expect(summary.tone).toBe("idle");
    expect(summary.headline).toBe("Not connected");
  });

  it("names the workspace the token was accepted for", () => {
    const summary = slackConnectionSummary(
      status({ configured: true, workspaceName: "Acme", lastPollAt: NOW }),
      NOW_MS,
    );
    expect(summary.tone).toBe("connected");
    expect(summary.headline).toBe("Connected to Acme");
    expect(summary.detail).toBe("Polled just now.");
  });

  it("reads a server that has just woken up as waiting rather than as broken", () => {
    const summary = slackConnectionSummary(
      status({ configured: true, workspaceName: "Acme" }),
      NOW_MS,
    );
    expect(summary.tone).toBe("connected");
    expect(summary.detail).toBe("No poll yet since this server woke up.");
  });

  it("ages the last poll", () => {
    const summary = slackConnectionSummary(
      status({
        configured: true,
        workspaceName: "Acme",
        lastPollAt: new Date(NOW_MS - 3 * 60_000).toISOString(),
      }),
      NOW_MS,
    );
    expect(summary.detail).toBe("Polled 3m ago.");
  });

  it("shows the last failure without pretending the token is gone", () => {
    const summary = slackConnectionSummary(
      status({
        configured: true,
        workspaceName: "Acme",
        lastPollAt: NOW,
        lastError: "missing_scope: channels:history",
      }),
      NOW_MS,
    );
    expect(summary.tone).toBe("error");
    expect(summary.headline).toBe("Connected to Acme");
    expect(summary.detail).toBe("missing_scope: channels:history");
  });

  it("falls back to naming Slack when the workspace never came back", () => {
    expect(slackConnectionSummary(status({ configured: true }), NOW_MS).headline).toBe(
      "Connected to Slack",
    );
  });
});
