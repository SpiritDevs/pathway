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
  schedule: vi.fn(),
  cancel: vi.fn(),
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
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (target: unknown) => ({
    data: target === "recovery" ? state.result : null,
    error: null,
    // Live subscriptions remain waiting for their next value after the snapshot arrives.
    isPending: true,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (command === "schedule" ? state.schedule : state.cancel),
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
