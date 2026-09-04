import {
  EnvironmentId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { WorkspacePreparationCard } from "./WorkspacePreparationCard";

vi.mock("~/state/terminalSessions", () => ({
  useAttachedTerminalSession: () => {
    throw new Error("Collapsed setup must not attach to a terminal");
  },
}));

const now = DateTime.makeUnsafe("2026-09-05T00:00:00Z");
const item: Extract<OrchestrationV2TurnItem, { type: "command_execution" }> = {
  id: TurnItemId.make("setup"),
  threadId: ThreadId.make("thread"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "running",
  title: "Checking out files",
  startedAt: now,
  completedAt: null,
  updatedAt: now,
  type: "command_execution",
  input: "Preparing workspace",
  workspacePreparation: { phase: "worktree", workspaceKind: "worktree", baseRef: "main" },
};

describe("WorkspacePreparationCard", () => {
  it("renders the current stage, pending stages and a details disclosure", () => {
    const html = renderToStaticMarkup(
      <WorkspacePreparationCard item={item} environmentId={EnvironmentId.make("env")} />,
    );
    expect(html).toContain("Creating a worktree");
    expect(html).toContain("lucide-loader-circle");
    expect(html).toContain("motion-reduce:animate-none");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Checking out files");
    expect(html).toContain("Starting setup script");
    expect(html).toContain("More details");
    expect(html).toContain("main");
    expect(html).toContain('role="progressbar"');
    expect(html).not.toContain("aria-valuenow");
  });
  it("shows Git checkout progress and removes the bar during cleanup", () => {
    const withProgress = {
      ...item,
      workspacePreparation: { ...item.workspacePreparation!, checkoutPercent: 65 },
    };
    const html = renderToStaticMarkup(
      <WorkspacePreparationCard item={withProgress} environmentId={EnvironmentId.make("env")} />,
    );
    expect(html).toContain('aria-valuenow="65"');
    expect(html).toContain("width:65%");
    const cancelling = renderToStaticMarkup(
      <WorkspacePreparationCard
        item={{
          ...withProgress,
          workspacePreparation: { ...withProgress.workspacePreparation, controlAction: "cancel" },
        }}
        environmentId={EnvironmentId.make("env")}
      />,
    );
    expect(cancelling).not.toContain('role="progressbar"');
  });
  it("keeps failures visible with details collapsed", () => {
    const html = renderToStaticMarkup(
      <WorkspacePreparationCard
        item={{ ...item, status: "failed", output: "Base branch could not be fetched" }}
        environmentId={EnvironmentId.make("env")}
      />,
    );
    expect(html).toContain("Workspace setup failed");
    expect(html).toContain("Base branch could not be fetched");
    expect(html).not.toContain('aria-current="step"');
    expect(html).not.toContain("animate-spin");
  });
  it("does not subscribe to a completed setup terminal until details are opened", () => {
    const html = renderToStaticMarkup(
      <WorkspacePreparationCard
        item={{
          ...item,
          status: "completed",
          workspacePreparation: {
            phase: "setup",
            workspaceKind: "worktree",
            terminalId: "setup-install",
          },
        }}
        environmentId={EnvironmentId.make("env")}
      />,
    );
    expect(html).toContain("Worktree created");
    expect(html).toContain("The setup script runs in its terminal while the agent starts.");
    expect(html).not.toContain('aria-label="Setup script output"');
  });
});

it("offers both controls only while a new worktree is running", () => {
  for (const status of ["running", "completed", "failed", "interrupted"] as const) {
    const html = renderToStaticMarkup(
      <WorkspacePreparationCard
        item={{ ...item, status }}
        environmentId={EnvironmentId.make("env")}
        onControl={async () => {}}
      />,
    );
    expect(html.includes(">Cancel</button>")).toBe(status === "running");
    expect(html.includes("Work locally")).toBe(status === "running");
  }
});
it("disables both controls when another client has already requested cancellation", () => {
  const html = renderToStaticMarkup(
    <WorkspacePreparationCard
      item={{
        ...item,
        workspacePreparation: {
          phase: "worktree",
          workspaceKind: "worktree",
          controlAction: "cancel",
        },
      }}
      environmentId={EnvironmentId.make("env")}
      onControl={async () => {}}
    />,
  );
  expect(html).toContain("Cancelling…");
  expect(html.match(/disabled=""/g)).toHaveLength(2);
});
