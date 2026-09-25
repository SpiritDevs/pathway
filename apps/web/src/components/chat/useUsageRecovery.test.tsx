import type { ReactElement } from "react";
import {
  CommandId,
  EnvironmentId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
  type UsageRecoveryResult,
} from "@spiritdevs/contracts";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const state = vi.hoisted(() => ({
  result: { recovery: null } as UsageRecoveryResult,
  usage: null as unknown,
  schedule: vi.fn(),
  cancel: vi.fn(),
  pause: vi.fn(),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    usageRecoveryLive: () => "recovery",
    providerUsageLive: () => "usage",
    scheduleUsageRecovery: "schedule",
    cancelUsageRecovery: "cancel",
    pauseUsageRecovery: "pause",
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (target: unknown) => ({
    data: target === "recovery" ? state.result : target === "usage" ? state.usage : null,
    error: null,
    // Live subscriptions remain waiting for their next value after the snapshot arrives.
    isPending: true,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === "schedule" ? state.schedule : command === "pause" ? state.pause : state.cancel,
}));
vi.mock("../../hooks/useNowMinute", () => ({
  useNowMinute: () => new Date().toISOString().slice(0, 16),
}));
vi.mock("../../lib/utils", () => ({
  newCommandId: () => "new-recovery",
  cn: (...values: string[]) => values.join(" "),
}));

import { recoveryLocalInput, useUsageRecovery } from "./useUsageRecovery";

const environmentId = EnvironmentId.make("remote-studio");
const threadId = ThreadId.make("parent-thread");
const sourceRunId = RunId.make("failed-run");
const instanceId = ProviderInstanceId.make("claude");
const input = {
  environmentId,
  threadId,
  supported: true,
  pauseSupported: true,
  projection: {
    runs: [
      {
        id: sourceRunId,
        ordinal: 1,
        status: "failed",
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "opus" },
      },
    ],
    turnItems: [],
    subagents: [],
  } as unknown as OrchestrationV2ThreadProjection,
  providerStatuses: [{ instanceId, driver: "claudeAgent" }] as ServerProvider[],
};
function render(props = input) {
  hooks.beginRender();
  return useUsageRecovery(props);
}
function click(node: unknown, label: string) {
  const button = visitElements(node, (element) => element.props.children === label);
  expect(button, label).not.toBeNull();
  expect(button!.props.disabled, `${label} must be enabled`).not.toBe(true);
  return (button!.props.onClick as () => void)();
}

beforeEach(() => {
  hooks.reset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-23T10:00:00Z"));
  state.result = {
    recovery: null,
    eligibility: { sourceRunId, suggestedResumeAt: "2026-09-23T11:01:45Z", childCount: 2 },
  };
  state.schedule.mockReset().mockResolvedValue({ _tag: "Success" });
  state.cancel.mockReset().mockResolvedValue({ _tag: "Success" });
  state.pause.mockReset().mockResolvedValue({ _tag: "Success" });
  state.usage = null;
});
afterEach(() => vi.useRealTimers());

it("opens while the live subscription waits for updates and schedules with the reset margin on the correct environment", async () => {
  let view = render();
  expect(view.banner?.presentation).toBe("lip");
  click(view.banner?.actions, "Resume after reset");
  view = render();
  expect((view.dialog as ReactElement<{ open: boolean }>).props.open).toBe(true);
  const dateField = visitElements(
    view.dialog,
    (element) => element.props.type === "datetime-local",
  );
  expect(dateField?.props.value).toBe(recoveryLocalInput(Date.parse("2026-09-23T11:01:45Z")));
  click(view.dialog, "Schedule recovery");
  await Promise.resolve();
  expect(state.schedule).toHaveBeenCalledWith({
    environmentId,
    input: {
      commandId: "new-recovery",
      threadId,
      sourceRunId,
      resumeAt: "2026-09-23T11:02:00.000Z",
    },
  });
});

it("resumes immediately once the reported reset has passed", async () => {
  state.result = {
    recovery: null,
    eligibility: {
      sourceRunId,
      suggestedResumeAt: "2026-09-23T10:01:00Z",
      resetAt: "2026-09-23T09:50:00Z",
      childCount: 2,
    },
  };
  const view = render();
  expect(view.canResumeNow).toBe(true);
  expect(view.banner?.title).toBe("Usage allowance reset");
  click(view.banner?.actions, "Resume now");
  await Promise.resolve();
  expect(state.schedule).toHaveBeenCalledWith({
    environmentId,
    input: {
      commandId: "new-recovery",
      threadId,
      sourceRunId,
      resumeAt: "2026-09-23T10:00:00.000Z",
    },
  });
  state.result = {
    recovery: null,
    eligibility: { ...state.result.eligibility!, resetAt: "2026-09-23T10:00:30Z" },
  };
  expect(render().canResumeNow).toBe(false);
});

it("offers change and cancel controls for a persisted timer", async () => {
  state.result = {
    recovery: {
      id: CommandId.make("scheduled"),
      threadId,
      sourceRunId,
      status: "scheduled",
      resumeAt: "2026-09-23T11:01:00Z",
      attempts: 1,
      message: "Waiting for the next reset",
    },
  };
  const view = render();
  expect(
    visitElements(view.banner?.actions, (element) => element.props.children === "Change time"),
  ).not.toBeNull();
  click(view.banner?.actions, "Change time");
  click(view.banner?.actions, "Cancel recovery");
  await Promise.resolve();
  expect(state.cancel).toHaveBeenCalledWith({ environmentId, input: { threadId } });
});

it("shows a child's inherited timer without offering a second timer or cancelling its parent", () => {
  state.result = {
    recovery: {
      id: CommandId.make("scheduled"),
      threadId: ThreadId.make("ancestor"),
      sourceRunId,
      status: "scheduled",
      resumeAt: "2026-09-23T11:01:00Z",
      attempts: 0,
      message: "Managed by parent",
    },
  };
  const view = render();
  expect(view.canSchedule).toBe(false);
  expect(view.banner?.title).toBe("Included in the parent thread’s recovery");
  expect(
    visitElements(view.banner?.actions, (element) => typeof element.props.onClick === "function"),
  ).toBeNull();
});

it("closes the editor when switching threads and hides unsupported servers", () => {
  render().open();
  const other = render({ ...input, threadId: ThreadId.make("other") });
  expect((other.dialog as ReactElement<{ open: boolean }>).props.open).toBe(false);
  expect(render({ ...input, supported: false }).banner).toBeNull();
});

const workingInput = {
  ...input,
  projection: {
    ...input.projection,
    runs: [{ ...input.projection!.runs[0]!, status: "running" }],
  } as unknown as OrchestrationV2ThreadProjection,
};
function lowUsage(usedPercent: number, weeklyResetsAt = "2026-09-23T12:00:00Z") {
  state.result = { recovery: null, eligibility: null };
  state.usage = [
    {
      instanceId,
      provider: "claudeAgent",
      status: "ok",
      stale: false,
      limits: [
        { window: "5-hour", usedPercent: 40, resetsAt: "2026-09-23T10:30:00Z" },
        { window: "Weekly", usedPercent, resetsAt: weeklyResetsAt },
      ],
    },
  ];
}

it("warns below 10% left and pauses working threads until the tightest window resets", async () => {
  lowUsage(93);
  const view = render(workingInput);
  expect(view.lowUsageBanner?.title).toBe("Usage almost used up · 7% left");
  click(view.lowUsageBanner?.actions, "Pause until reset");
  await Promise.resolve();
  expect(state.pause).toHaveBeenCalledWith({
    environmentId,
    input: { commandId: "new-recovery", threadId, resumeAt: "2026-09-23T12:01:00.000Z" },
  });
  expect(view.menuAction?.label).toBe("Pause until reset");
  expect(view.menuAction?.disabledReason).toBeNull();
});

it("stays quiet above 10% and only offers pause while the agent works", () => {
  lowUsage(85);
  expect(render(workingInput).lowUsageBanner).toBeNull();
  lowUsage(95);
  const idle = render({
    ...input,
    projection: {
      ...input.projection,
      runs: [{ ...input.projection!.runs[0]!, status: "completed" }],
    } as unknown as OrchestrationV2ThreadProjection,
  });
  expect(idle.lowUsageBanner?.actions).toBeUndefined();
  expect(idle.menuAction?.disabledReason).toBe("Available while the agent is working.");
  const queued = render({
    ...input,
    projection: {
      ...input.projection,
      runs: [{ ...input.projection!.runs[0]!, status: "queued" }],
    } as unknown as OrchestrationV2ThreadProjection,
  });
  expect(queued.menuAction?.disabledReason).toBe("Send or remove queued messages before pausing.");
  expect(queued.lowUsageBanner?.actions).toBeUndefined();
  expect(String(queued.lowUsageBanner?.description)).not.toContain("Pause");
});

it("shows a pause until its run stops, then offers to resume or cancel it", async () => {
  const pause = {
    id: CommandId.make("pause"),
    threadId,
    sourceRunId,
    status: "scheduled",
    reason: "pause",
    resumeAt: "2026-09-23T12:01:00Z",
    attempts: 0,
    message: "Paused",
  } as const;
  state.result = { recovery: { ...pause, pausedAt: null } };
  let view = render(workingInput);
  expect(view.banner?.title).toBe("Pausing after the current step");
  expect(view.menuAction?.label).toBe("Cancel pause");
  state.result = { recovery: { ...pause, pausedAt: "2026-09-23T10:00:00Z" } };
  view = render();
  expect(view.menuAction?.label).toBe("Resume now");
  click(view.banner?.actions, "Resume now");
  await Promise.resolve();
  expect(state.schedule).toHaveBeenCalledWith({
    environmentId,
    input: {
      commandId: "new-recovery",
      threadId,
      sourceRunId,
      resumeAt: "2026-09-23T10:00:00.000Z",
    },
  });
  click(view.banner?.actions, "Cancel pause");
  await Promise.resolve();
  expect(state.cancel).toHaveBeenCalledWith({ environmentId, input: { threadId } });
});

it("keeps a dismissed warning hidden while a relative reset drifts, until the next window", () => {
  lowUsage(93);
  const view = render(workingInput);
  view.lowUsageBanner!.onDismiss!();
  // Providers that report "resets in N seconds" move the reset slightly on every refresh.
  lowUsage(94, "2026-09-23T12:01:30Z");
  expect(render(workingInput).lowUsageBanner).toBeNull();
  lowUsage(95, "2026-09-30T12:00:00Z");
  expect(render(workingInput).lowUsageBanner?.title).toBe("Usage almost used up · 5% left");
});
