import { expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@spiritdevs/contracts";
import type { SimBuildJob, SimBuildUpdate } from "@spiritdevs/contracts/simBuild";
import { applySimBuildUpdate, EMPTY_SIM_BUILD_VIEW } from "./simBuild.ts";
const job: SimBuildJob = {
  environmentId: EnvironmentId.make("env"),
  projectId: ProjectId.make("p"),
  threadId: ThreadId.make("t"),
  action: "run",
  requestId: "request",
  hostId: "local",
  deviceId: "sim",
  containerPath: "App.xcodeproj",
  scheme: "App",
  id: "job",
  workspaceRoot: "/workspace",
  developerDir: null,
  phase: "building",
  terminal: false,
  artifact: null,
  failure: null,
  createdAt: 1,
  updatedAt: 1,
};
const frame = (patch: Partial<SimBuildUpdate> = {}): SimBuildUpdate => ({
  kind: "snapshot",
  job,
  receipts: [{ sequence: 1, kind: "phase", job }],
  logs: [{ sequence: 1, text: "first\n", diagnostics: [] }],
  firstLogSequence: 1,
  nextLogSequence: 2,
  ...patch,
});
it("folds replay without duplicate logs or receipts", () => {
  const initial = applySimBuildUpdate(EMPTY_SIM_BUILD_VIEW, frame());
  const next = frame({ kind: "update", job: { ...job, phase: "installing" } });
  const view = applySimBuildUpdate(initial, next);
  expect(view.logs).toHaveLength(1);
  expect(view.receipts).toHaveLength(1);
  expect(view.job?.phase).toBe("installing");
});
it("shows truncation and bounds client memory for a lagging observer", () => {
  const initial = applySimBuildUpdate(EMPTY_SIM_BUILD_VIEW, frame());
  const update = frame({
    kind: "update",
    firstLogSequence: 10,
    nextLogSequence: 15,
    logs: Array.from({ length: 5 }, (_, i) => ({
      sequence: 10 + i,
      text: "x".repeat(16384),
      diagnostics: [],
    })),
  });
  const view = applySimBuildUpdate(initial, update);
  expect(view.logsTruncated).toBe(true);
  expect(view.logs).toHaveLength(4);
  expect(view.nextLogSequence).toBe(15);
});
it("replaces a reconnect snapshot and isolates another job", () => {
  const before = applySimBuildUpdate(EMPTY_SIM_BUILD_VIEW, frame());
  const after = applySimBuildUpdate(
    before,
    frame({
      firstLogSequence: 5,
      nextLogSequence: 6,
      logs: [{ sequence: 5, text: "last\n", diagnostics: [] }],
      job: { ...job, phase: "running", terminal: true },
    }),
  );
  expect(after.logs.map((log) => log.sequence)).toEqual([5]);
  expect(after.logsTruncated).toBe(true);
  expect(after.job?.terminal).toBe(true);
  const other = applySimBuildUpdate(after, frame({ job: { ...job, id: "another" } }));
  expect(other.logsTruncated).toBe(false);
  expect(other.job?.id).toBe("another");
});
