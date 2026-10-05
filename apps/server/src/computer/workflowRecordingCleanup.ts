/**
 * Deleting a thread cancels its live Record a skill capture and deletes its
 * saved evidence on the host Mac. Thread deletion is final, so nothing could
 * reach those files through the normal Discard path afterwards.
 *
 * @module computer/workflowRecordingCleanup
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import type { ComputerManager } from "./ComputerManager.ts";
import { ComputerService } from "./Services/ComputerService.ts";

export const discardDeletedThreadRecordings = <E>(
  events: Stream.Stream<{ readonly type: string; readonly threadId: string }, E>,
  manager: ComputerManager,
) =>
  events.pipe(
    Stream.filter((event) => event.type === "thread.deleted"),
    Stream.runForEach((event) =>
      manager.recordWorkflow("status", event.threadId).pipe(
        Effect.flatMap((status) =>
          status.supported ? manager.recordWorkflow("cancel", event.threadId) : Effect.void,
        ),
        Effect.catch((error) =>
          Effect.logWarning("Could not discard a deleted thread's workflow recording", {
            threadId: event.threadId,
            error: error.message,
          }),
        ),
      ),
    ),
  );

export const workflowRecordingCleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const computer = yield* ComputerService;
    if (!computer.supported) return;
    yield* forkParked(
      discardDeletedThreadRecordings(threads.streamDomainEvents, computer.manager).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Workflow recording cleanup stopped", { cause }),
        ),
      ),
    );
  }),
);
