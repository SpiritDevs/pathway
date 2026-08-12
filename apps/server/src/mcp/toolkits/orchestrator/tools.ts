import {
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpCreatedThread,
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpCreateThreadsResult,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpDeleteScheduledTaskInput,
  OrchestratorMcpDeleteScheduledTaskResult,
  OrchestratorMcpFailure,
  OrchestratorMcpListScheduledTasksResult,
  OrchestratorMcpScheduleTaskInput,
  OrchestratorMcpScheduleTaskResult,
  OrchestratorMcpTaskCancelInput,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpUpdateScheduledTaskInput,
  OrchestratorMcpTaskStatusInput,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadStartInput,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestratorMcpService } from "../../OrchestratorMcpService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, OrchestratorMcpService];

export const OrchestratorCapabilitiesTool = Tool.make("orchestrator_capabilities", {
  description:
    "List the V2 provider instances, models, inherited runtime settings, and app-owned orchestration features available to this Pathway thread.",
  success: OrchestratorMcpCapabilitiesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get orchestration capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const DelegateTaskTool = Tool.make("delegate_task", {
  description:
    "Delegate one task to a Pathway-owned child agent/subagent of THIS thread and run it with only the supplied task prompt, without copying parent conversation history. Use this whenever the user asks for an agent, subagent, worker, delegated task, or parallel help—including cross-provider work. The childThreadId is backing storage, not an ordinary top-level thread. Provider, model, model options (see orchestrator_capabilities), runtime mode, and interaction mode inherit unless target overrides them. Prefer mode='async' for long work; mode='wait' blocks until completion or timeout. An async child's completion wakes this thread with a continuation message naming the task (queued behind any turn in progress), so end the turn instead of polling or spawning watchers; use task_status only when the result is needed mid-turn.",
  parameters: OrchestratorMcpDelegateTaskInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delegate a child task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const TaskStatusTool = Tool.make("task_status", {
  description:
    "Read the latest durable state and final summary for a Pathway-owned delegated task created by this parent thread. Reading a terminal result acknowledges its automatic parent delivery.",
  parameters: OrchestratorMcpTaskStatusInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get delegated task status")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const TaskCancelTool = Tool.make("task_cancel", {
  description:
    "Request interruption of an active Pathway-owned delegated task and dispose its automatic parent delivery. Completed task results remain available.",
  parameters: OrchestratorMcpTaskCancelInput,
  success: OrchestratorMcpTaskCancelResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Cancel delegated task")
  .annotate(Tool.Destructive, true);

export const ScheduleTaskTool = Tool.make("schedule_task", {
  description:
    "Create persistent recurring work in the app scheduler, which runs even when no turn is active. Pass schedule as a STRUCTURED OBJECT, never JSON text: {type:'interval', everyMs:3600000} means hourly; {type:'fixed_time', timeOfDay:'09:00', weekdays:[1,2,3,4,5]} means weekday mornings. By default (bindToCurrentThread=true) each run posts into THIS thread; use false only when the user wants a fresh top-level thread per run. Provider, model, and runtime settings inherit from this thread. Report the returned schedule and nextRunAt after success.",
  parameters: OrchestratorMcpScheduleTaskInput,
  success: OrchestratorMcpScheduleTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Schedule a recurring task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ListScheduledTasksTool = Tool.make("list_scheduled_tasks", {
  description:
    "List the recurring scheduled tasks in the calling thread's project, including their id, schedule, prompt, enabled state, bound thread, next run time, and last run status. Use the returned scheduledTaskId with update_scheduled_task or delete_scheduled_task.",
  success: OrchestratorMcpListScheduledTasksResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List scheduled tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const UpdateScheduledTaskTool = Tool.make("update_scheduled_task", {
  description:
    "Update an existing scheduled task by scheduledTaskId (from list_scheduled_tasks). Only the provided fields change; omit a field to leave it as-is. Use enabled=false to pause a task without deleting it. Set bindToCurrentThread to move the task between posting into this thread and launching a fresh thread per run.",
  parameters: OrchestratorMcpUpdateScheduledTaskInput,
  success: OrchestratorMcpScheduleTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update a scheduled task")
  .annotate(Tool.Destructive, true);

export const DeleteScheduledTaskTool = Tool.make("delete_scheduled_task", {
  description:
    "Permanently delete a scheduled task by scheduledTaskId (from list_scheduled_tasks). The task stops running immediately. To keep it but stop runs, use update_scheduled_task with enabled=false instead.",
  parameters: OrchestratorMcpDeleteScheduledTaskInput,
  success: OrchestratorMcpDeleteScheduledTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delete a scheduled task")
  .annotate(Tool.Destructive, true);

export const CreateThreadsTool = Tool.make("create_threads", {
  description:
    "Create one or more ORDINARY TOP-LEVEL Pathway conversations. This is not delegation and does not create child agents/subagents. If the user asks for agents, subagents, workers, delegation, or parallel help, call delegate_task once per child instead—even when selecting different providers. Use create_threads only when the user explicitly asks for separate/new/top-level threads or conversations. Each entry may override provider, model, options, runtime mode, and interaction mode; omitted settings inherit.",
  parameters: OrchestratorMcpCreateThreadsInput,
  success: OrchestratorMcpCreateThreadsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create Pathway threads")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ThreadStartTool = Tool.make("t3_thread_start", {
  description:
    "Create an ordinary TOP-LEVEL Pathway conversation and immediately start its first turn. This is not a child agent/subagent; use delegate_task for delegated work. The new thread inherits this thread's project, checkout, provider, model, and runtime settings unless overridden. Use t3_thread_wait and t3_thread_read to collect its result.",
  parameters: OrchestratorMcpThreadStartInput,
  success: OrchestratorMcpCreatedThread,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Start a Pathway thread")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ThreadListTool = Tool.make("t3_thread_list", {
  description:
    "List Pathway threads in the calling thread's project, newest first. Filter by durable run status or title and paginate with the returned cursor. Threads from other projects are never exposed.",
  parameters: OrchestratorMcpThreadListInput,
  success: OrchestratorMcpThreadListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List Pathway threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadReadTool = Tool.make("t3_thread_read", {
  description:
    "Read durable state and a paginated timeline from a Pathway thread in the calling project. The default messages view returns user messages, assistant messages, and proposed plans; activity returns all summarized timeline items. Reading an untruncated terminal assistant result from this parent thread's direct app-owned child acknowledges that child's automatic completion delivery. Continue with afterPosition=nextPosition.",
  parameters: OrchestratorMcpThreadReadInput,
  success: OrchestratorMcpThreadReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a Pathway thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadSendTool = Tool.make("t3_thread_send", {
  description:
    "Send a message to a Pathway thread in the calling project. mode='auto' starts an idle thread, steers a fully active turn, or queues behind a turn that is not yet steerable. Use queue for a separate follow-up turn, steer for an in-flight update, or restart to interrupt-and-restart the active turn. clientRequestId makes retries idempotent.",
  parameters: OrchestratorMcpThreadSendInput,
  success: OrchestratorMcpThreadSendResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Send to a Pathway thread")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ThreadWaitTool = Tool.make("t3_thread_wait", {
  description:
    "Wait for a Pathway thread run to reach a terminal durable state. Without runId, the latest run at call time is selected; an idle thread returns immediately. Timeout does not interrupt work, so call again or use t3_thread_read/list after timedOut=true. Waiting reports status only and does not acknowledge a delegated result.",
  parameters: OrchestratorMcpThreadWaitInput,
  success: OrchestratorMcpThreadWaitResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Wait for a Pathway thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadInterruptTool = Tool.make("t3_thread_interrupt", {
  description:
    "Request interruption of a running turn in a Pathway thread in the calling project. Without runId, the newest interruptible run is selected. Terminal runs and threads without an active turn return without another side effect. clientRequestId makes retries idempotent.",
  parameters: OrchestratorMcpThreadInterruptInput,
  success: OrchestratorMcpThreadInterruptResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Interrupt a Pathway thread")
  .annotate(Tool.Destructive, true);

export const OrchestratorToolkit = Toolkit.make(
  OrchestratorCapabilitiesTool,
  DelegateTaskTool,
  TaskStatusTool,
  TaskCancelTool,
  ScheduleTaskTool,
  ListScheduledTasksTool,
  UpdateScheduledTaskTool,
  DeleteScheduledTaskTool,
  CreateThreadsTool,
  ThreadStartTool,
  ThreadListTool,
  ThreadReadTool,
  ThreadSendTool,
  ThreadWaitTool,
  ThreadInterruptTool,
);
