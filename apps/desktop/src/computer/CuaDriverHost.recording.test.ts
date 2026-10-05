import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { idleWorkflowRecording } from "@spiritdevs/contracts";
import { makeFixture } from "./testing/CuaDriverFixture.ts";
import type { WorkflowRecorder } from "./WorkflowRecorder.ts";

describe("authenticated recording host", () => {
  it.live("routes only attributed authenticated calls without launching the driver", () =>
    Effect.gen(function* () {
      const calls: Array<[string, string]> = [];
      const workflowRecorder: WorkflowRecorder = {
        call: (action, thread) =>
          Effect.sync(() => {
            calls.push([action, thread]);
            return idleWorkflowRecording(true);
          }),
      };
      const f = yield* makeFixture({ workflowRecorder });
      expect((yield* f.send({ method: "workflow_recording", action: "status" })).ok).toBe(false);
      expect(
        (yield* f.send({
          method: "workflow_recording",
          action: "start",
          task: { threadId: "owner" },
          capability: "wrong",
        })).ok,
      ).toBe(false);
      expect(
        (yield* f.send({
          method: "workflow_recording",
          action: "invalid",
          task: { threadId: "owner" },
        })).ok,
      ).toBe(false);
      expect(calls).toEqual([]);
      expect(
        (yield* f.send({
          method: "workflow_recording",
          action: "start",
          task: { threadId: "owner" },
        })).result,
      ).toMatchObject({ supported: true });
      yield* f.host.pauseDesktop("screen-lock");
      expect(
        (yield* f.send({
          method: "workflow_recording",
          action: "start",
          task: { threadId: "owner" },
        })).ok,
      ).toBe(false);
      for (const action of ["status", "stop", "cancel"])
        expect(
          (yield* f.send({ method: "workflow_recording", action, task: { threadId: "owner" } })).ok,
        ).toBe(true);
      expect(calls).toEqual([
        ["start", "owner"],
        ["status", "owner"],
        ["stop", "owner"],
        ["cancel", "owner"],
      ]);
      expect(yield* f.events).toEqual([]);
    }),
  );
  it.live("cancels capture on pause, suspension, and host disposal", () =>
    Effect.gen(function* () {
      let cancelled = 0;
      const workflowRecorder: WorkflowRecorder = {
        call: () => Effect.succeed(idleWorkflowRecording(true)),
        cancelActive: Effect.sync(() => {
          cancelled += 1;
        }),
      };
      const f = yield* makeFixture({ workflowRecorder });
      yield* f.host.pauseDesktop("screen-lock");
      expect(cancelled).toBe(1);
      yield* f.host.suspend;
      expect(cancelled).toBe(2);
      yield* f.closeHostScope;
      expect(cancelled).toBe(3);
    }),
  );
  it.live("pauses Computer input while a recording is live and keeps reads open", () =>
    Effect.gen(function* () {
      let active = true;
      const workflowRecorder: WorkflowRecorder = {
        call: () => Effect.succeed(idleWorkflowRecording(true)),
        isActive: () => active,
      };
      const f = yield* makeFixture({ workflowRecorder });
      expect(yield* f.send({ method: "call", name: "click", args: { x: 1, y: 1 } })).toMatchObject({
        ok: true,
        result: {
          isError: true,
          structuredContent: { effect: "refused", code: "computer_input_paused" },
        },
      });
      expect(yield* f.send({ method: "call", name: "list_windows" })).toMatchObject({ ok: true });
      active = false;
      expect(
        (yield* f.send({ method: "call", name: "click", args: { x: 1, y: 1 } })).result,
      ).not.toMatchObject({ structuredContent: { code: "computer_input_paused" } });
    }),
  );
  it.live("reports unsupported on a host without a recorder", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      expect(
        (yield* f.send({
          method: "workflow_recording",
          action: "status",
          task: { threadId: "owner" },
        })).result,
      ).toMatchObject({ supported: false });
      expect(
        (yield* f.send({
          method: "workflow_recording",
          action: "start",
          task: { threadId: "owner" },
        })).ok,
      ).toBe(false);
    }),
  );
});
