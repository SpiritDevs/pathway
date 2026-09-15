import { assertConversationDispatch } from "./conversationLifecycle.ts";
import { resolveWorkAssignments } from "./aiOrchestratorContext.ts";
// @effect-diagnostics globalDate:off -- Convex supplies transaction time.
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { ModelSelection } from "@spiritdevs/contracts";
import { CloudAgentThreadShell } from "@spiritdevs/contracts/cloudProject";
import {
  OrchestratorDelegationCatalog,
  delegationSelectionProblem,
} from "@spiritdevs/contracts/aiOrchestrator";
import type { OrchestratorAction } from "@spiritdevs/contracts/aiOrchestrator";
import type { MutationCtx } from "../_generated/server.js";
import type { Doc } from "../_generated/dataModel.js";
import { backendError } from "./errors.ts";
import { mintDomainId } from "./domainIds.ts";
import {
  eligibleOrchestratorEnvironment,
  orchestratorOwnerScope,
  orchestratorCommandAllowed,
} from "./aiOrchestratorAuthority.ts";
import { hasCompanyPermission, hasRecordPermission } from "../../src/permissions.ts";
import { appendCompanyChanges, encodeEnvironmentCommand } from "./companyApply.ts";
import { ORCHESTRATOR_WORKER_REPORT_INSTRUCTIONS } from "@spiritdevs/contracts/orchestratorInspection";
import { orchestratorReadTarget } from "./aiOrchestratorTargets.ts";
import { inheritAllowanceScopes } from "../providerAllowanceBudgets.ts";

const fail = (message: string): never => {
  throw backendError("orchestrator-work", message);
};
const decodeSelection = Schema.decodeUnknownSync(ModelSelection);
const decodeCatalog = Schema.decodeUnknownSync(OrchestratorDelegationCatalog);
const decodeShell = Schema.decodeUnknownOption(CloudAgentThreadShell);
export async function queueOrchestratorWork(
  ctx: MutationCtx,
  orchestrator: Doc<"aiOrchestrators">,
  chat: Doc<"aiOrchestratorChats">,
  action: Extract<OrchestratorAction, { kind: "delegate" }>,
  continuationThreadId?: string,
) {
  await assertConversationDispatch(ctx, chat.id);
  if (!orchestrator.capabilities.includes("threads.delegate"))
    return fail("This orchestrator cannot delegate work.");
  if (
    !action.title.trim() ||
    action.title.length > 160 ||
    !action.prompt.trim() ||
    action.prompt.length > 32000
  )
    return fail("An assignment needs a short title and instructions under 32,000 characters.");
  const scope = await orchestratorOwnerScope(ctx, orchestrator, action.companyId);
  if (
    !scope ||
    !hasCompanyPermission(scope.permissions, "remoteAgents.dispatch") ||
    !hasCompanyPermission(scope.permissions, "remoteAgents.control")
  )
    return fail("The orchestrator's owner no longer has dispatch permission in this workspace.");
  const project =
    action.projectId === null
      ? null
      : await ctx.db
          .query("cloudProjects")
          .withIndex("by_company_and_domain_id", (q) =>
            q.eq("companyId", scope.company._id).eq("id", action.projectId!),
          )
          .unique();
  if (
    (action.projectId === null && orchestrator.projectId !== null) ||
    (action.projectId !== null &&
      (!project ||
        project.deletedAt !== null ||
        project.archivedAt !== null ||
        (orchestrator.projectId && orchestrator.projectId !== project.id) ||
        !hasRecordPermission(scope.permissions, "projects.read", project.teamIds)))
  )
    return fail("Delegate this project to its own coordinator, or choose an authorized project.");
  const registration = await ctx.db
    .query("environmentRegistrations")
    .withIndex("by_company_and_environment", (q) =>
      q.eq("companyId", scope.company._id).eq("environmentId", action.environmentId),
    )
    .unique();
  if (!registration || !(await eligibleOrchestratorEnvironment(ctx, orchestrator, registration)))
    return fail("This orchestrator cannot use that environment.");
  const binding = project
    ? await ctx.db
        .query("environmentBindings")
        .withIndex("by_company_and_project", (q) =>
          q.eq("companyId", scope.company._id).eq("cloudProjectId", project._id),
        )
        .collect()
    : [];
  if (
    project &&
    !binding.some((item) => item.environmentId === action.environmentId && item.status === "active")
  )
    return fail("The project has no active checkout on that environment.");
  const preset = continuationThreadId
    ? undefined
    : (orchestrator.workerModels ?? []).find(
        (choice) => choice.environmentId === action.environmentId,
      );
  const selection = action.selection ?? preset?.selection ?? null;
  let selectionProblem: string | null = null;
  if (
    selection &&
    registration.orchestratorDelegationCatalog &&
    Date.now() - (registration.orchestratorDelegationCatalogAt ?? 0) <= 120000
  ) {
    const catalog = decodeCatalog(registration.orchestratorDelegationCatalog);
    selectionProblem = delegationSelectionProblem(decodeSelection(selection), catalog, true);
  }
  const selectionReason = continuationThreadId
    ? "Continuing with the existing thread's model."
    : action.selection
      ? action.selectionReason?.trim() || "Coordinator selected this model explicitly."
      : preset
        ? `Default worker preset: ${preset.name}.`
        : "Using the target project's default, then the environment text-generation default. The coordinator did not choose a model.";
  const queued = await ctx.db
    .query("aiOrchestratorWork")
    .withIndex("by_orchestrator_status", (q) =>
      q.eq("orchestratorId", orchestrator.id).eq("status", "queued"),
    )
    .take(100);
  if (queued.length >= 100)
    return fail("The assignment queue is full. Finish or cancel outstanding work first.");
  const id = mintDomainId(Date.now());
  const status = selectionProblem ? ("failed" as const) : ("queued" as const);
  const detail = selectionProblem
    ? `${selectionProblem} No fallback was selected.`
    : "Waiting for a work slot.";
  await ctx.db.insert("aiOrchestratorWork", {
    id,
    chatId: chat.id,
    orchestratorId: orchestrator.id,
    title: action.title.trim(),
    environmentId: action.environmentId,
    projectId: action.projectId,
    companyId: action.companyId,
    threadId: continuationThreadId ?? null,
    ...(continuationThreadId ? { continuation: true } : {}),
    status,
    completionNotified: false,
    sourceSequence: chat.lastSequence,
    resultRequired: !selectionProblem,
    resultCollected: false,
    detail,
    prompt: action.prompt,
    selection: selection
      ? {
          instanceId: selection.instanceId,
          model: selection.model,
          ...(selection.options
            ? { options: selection.options.map((option) => ({ ...option })) }
            : {}),
        }
      : null,
    selectionReason,
    selectionExplicit: action.selection !== null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return { workId: id, status, detail };
}

export async function continueOrchestratorThread(
  ctx: MutationCtx,
  orchestrator: Doc<"aiOrchestrators">,
  chat: Doc<"aiOrchestratorChats">,
  action: Extract<OrchestratorAction, { kind: "continueThread" }>,
) {
  if (
    !orchestrator.capabilities.includes("threads.control") ||
    !orchestrator.capabilities.includes("threads.read")
  )
    return fail("This orchestrator cannot continue existing threads.");
  const target = await orchestratorReadTarget(ctx, orchestrator, chat, action);
  if (!target.thread || !target.shell) return fail("The thread is unavailable.");
  if (
    target.shell.orchestratorOrigin &&
    target.shell.orchestratorOrigin.orchestratorId !== orchestrator.id
  )
    return fail("Ask this thread's assigning orchestrator to continue its work.");
  const work = await queueOrchestratorWork(
    ctx,
    orchestrator,
    chat,
    {
      kind: "delegate",
      title: action.title,
      prompt: action.prompt,
      companyId: action.companyId,
      environmentId: action.environmentId,
      projectId: target.project?.id ?? null,
      selection: null,
    },
    action.threadId,
  );
  await inheritAllowanceScopes(ctx, action.companyId, [{ kind: "chat", chatId: chat.id }], {
    kind: "thread",
    environmentId: action.environmentId,
    threadId: action.threadId,
  });
  return { ...work, threadId: action.threadId };
}

/** Start acknowledgements identify a thread; only a published terminal run means its work finished. */
export async function refreshOrchestratorWork(
  ctx: MutationCtx,
  orchestrator: Doc<"aiOrchestrators">,
) {
  const active = await ctx.db
    .query("aiOrchestratorWork")
    .withIndex("by_orchestrator_status", (q) =>
      q.eq("orchestratorId", orchestrator.id).eq("status", "working"),
    )
    .take(32);
  const unknown = await ctx.db
    .query("aiOrchestratorWork")
    .withIndex("by_orchestrator_status", (q) =>
      q.eq("orchestratorId", orchestrator.id).eq("status", "unknown"),
    )
    .take(32);
  const queued = await ctx.db
    .query("aiOrchestratorWork")
    .withIndex("by_orchestrator_status", (q) =>
      q.eq("orchestratorId", orchestrator.id).eq("status", "queued"),
    )
    .take(100);
  let occupied = 0;
  for (const work of [...active, ...unknown, ...queued.filter((work) => work.commandId)]) {
    const scope = work.companyId
      ? await orchestratorOwnerScope(ctx, orchestrator, work.companyId)
      : null;
    if (!scope) {
      occupied++;
      continue;
    }
    const command = work.commandId
      ? await ctx.db
          .query("environmentCommands")
          .withIndex("by_company_and_domain_id", (q) =>
            q.eq("companyId", scope.company._id).eq("id", work.commandId!),
          )
          .unique()
      : null;
    if (command && ["failed", "canceled", "expired"].includes(command.state)) {
      const cancelled = command.state === "canceled";
      await ctx.db.patch(work._id, {
        status: cancelled ? "cancelled" : "failed",
        detail: command.error ?? "The environment did not start this assignment.",
        updatedAt: Date.now(),
      });
      continue;
    }
    let threadId = work.threadId;
    const result: unknown = command?.result;
    if (
      command?.state === "succeeded" &&
      typeof result === "object" &&
      result !== null &&
      "threadId" in result &&
      typeof result.threadId === "string"
    )
      threadId = result.threadId;
    const published = threadId
      ? await ctx.db
          .query("agentThreads")
          .withIndex("by_company_and_environment_and_thread", (q) =>
            q
              .eq("companyId", scope.company._id)
              .eq("environmentId", work.environmentId)
              .eq("threadId", threadId!),
          )
          .unique()
      : null;
    const shell = published ? decodeShell(published.shell) : Option.none();
    const registration = await ctx.db
      .query("environmentRegistrations")
      .withIndex("by_company_and_environment", (q) =>
        q.eq("companyId", scope.company._id).eq("environmentId", work.environmentId),
      )
      .unique();
    const offline =
      !registration ||
      registration.state !== "active" ||
      (registration.lastSeenAt ?? 0) < Date.now() - 90_000;
    let resultRunId = work.resultRunId;
    let status: Doc<"aiOrchestratorWork">["status"] = threadId ? "working" : "queued";
    let detail = threadId
      ? "Agent thread is working."
      : "Waiting for the environment to accept this assignment.";
    if (
      !work.continuation &&
      Option.isSome(shell) &&
      (!work.resultRunId || shell.value.latestRunId === work.resultRunId) &&
      shell.value.activeRunId === null &&
      shell.value.latestRunId !== null
    ) {
      if (shell.value.status === "completed") {
        status = "completed";
        resultRunId = shell.value.latestRunId;
        detail = "The delegated run finished. Waiting for its findings to return.";
      } else if (
        ["failed", "interrupted", "cancelled", "rolled_back"].includes(shell.value.status)
      ) {
        status = shell.value.status === "failed" ? "failed" : "cancelled";
        resultRunId = shell.value.latestRunId;
        detail = `The delegated run ${shell.value.status}.`;
      }
    }
    if (offline && status !== "completed" && status !== "failed" && status !== "cancelled") {
      status = threadId || command?.state === "claimed" ? "unknown" : "queued";
      detail =
        status === "unknown"
          ? "Environment offline. Its accepted work may still be running."
          : "Queued until an eligible environment is available.";
    }
    if (!offline && Option.isSome(shell) && shell.value.allowanceHold) {
      detail = shell.value.allowanceHold;
      if (shell.value.status === "starting") status = "queued";
    }
    if (work.stopRequested && !work.stopConfirmed) {
      status = "unknown";
      if (threadId && !work.controlsPending && !work.interruptCommandId)
        await interruptWork(ctx, orchestrator, work, threadId);
      detail = offline
        ? "Stop requested. The offline environment has not confirmed interruption."
        : "Stop requested. Waiting for the delegated thread to confirm it stopped.";
    }
    if (work.stopConfirmed) {
      status = "cancelled";
      detail = work.detail;
    }
    const resolvedSelection = Option.isSome(shell) ? shell.value.modelSelection : null;
    if (
      (!work.selection && resolvedSelection !== null) ||
      status !== work.status ||
      detail !== work.detail ||
      threadId !== work.threadId ||
      resultRunId !== work.resultRunId
    ) {
      await ctx.db.patch(work._id, {
        status,
        detail,
        threadId,
        ...(resultRunId ? { resultRunId } : {}),
        ...(!work.selection && resolvedSelection
          ? {
              selection: {
                instanceId: resolvedSelection.instanceId,
                model: resolvedSelection.model,
                ...(resolvedSelection.options
                  ? { options: resolvedSelection.options.map((option) => ({ ...option })) }
                  : {}),
              },
            }
          : {}),
        updatedAt: Date.now(),
      });
    }
    if (["queued", "working", "unknown"].includes(status)) occupied++;
  }
  if (orchestrator.status !== "active" || !orchestrator.capabilities.includes("threads.delegate"))
    return;
  for (const work of queued.filter((work) => !work.commandId && !work.stopRequested)) {
    if (occupied >= orchestrator.maxAssignments) break;
    const dispatchChat = await ctx.db
      .query("aiOrchestratorChats")
      .withIndex("by_domain_id", (q) => q.eq("id", work.chatId))
      .unique();
    if (!dispatchChat || dispatchChat.archived || dispatchChat.lifecycle) continue;
    const scope = work.companyId
      ? await orchestratorOwnerScope(ctx, orchestrator, work.companyId)
      : null;
    if (!scope) continue;
    const project =
      work.projectId === null
        ? null
        : await ctx.db
            .query("cloudProjects")
            .withIndex("by_company_and_domain_id", (q) =>
              q.eq("companyId", scope.company._id).eq("id", work.projectId!),
            )
            .unique();
    if (work.projectId !== null && !project) continue;
    const now = Date.now(),
      commandId = mintDomainId(now);
    const command = {
      id: commandId,
      companyId: scope.company._id,
      targetEnvironmentId: work.environmentId,
      cloudProjectId: project?._id ?? null,
      bindingId: null,
      kind: work.continuation ? ("sendMessage" as const) : ("startThread" as const),
      args: work.continuation
        ? {
            kind: "sendMessage",
            threadId: work.threadId!,
            message: work.prompt + ORCHESTRATOR_WORKER_REPORT_INSTRUCTIONS,
          }
        : {
            kind: "startThread",
            prompt: work.prompt + ORCHESTRATOR_WORKER_REPORT_INSTRUCTIONS,
            modelSelection: work.selection ?? null,
          },
      issuedByMembershipId: scope.membership._id,
      orchestratorId: orchestrator.id,
      onBehalfOfActor: {
        kind: "agent" as const,
        provider: `orchestrator:${orchestrator.id}`,
        onBehalfOfMembershipId: scope.membership.id,
      },
      state: "pending" as const,
      claimedByEnvironmentId: null,
      claimGeneration: 0,
      claimExpiresAt: null,
      expiresAt: now + 24 * 60 * 60 * 1000,
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    const commandDocId = await ctx.db.insert("environmentCommands", command);
    await ctx.db.patch(work._id, { commandId });
    const inserted = (await ctx.db.get(commandDocId))!;
    if (!(await orchestratorCommandAllowed(ctx, inserted))) {
      await ctx.db.delete(commandDocId);
      await ctx.db.patch(work._id, {
        status: "cancelled",
        detail: "The orchestrator's permission or scope changed.",
        updatedAt: now,
      });
      continue;
    }
    await appendCompanyChanges(ctx, {
      companyId: scope.company._id,
      actor: command.onBehalfOfActor,
      changes: [
        {
          entityKind: "environmentCommand",
          entityId: command.id,
          changeKind: "upsert",
          versionDocId: commandDocId,
          payload: await encodeEnvironmentCommand(ctx, inserted),
        },
      ],
    });
    await ctx.db.patch(work._id, {
      commandId,
      detail: "Waiting for the environment to accept this assignment.",
      updatedAt: now,
    });
    occupied++;
  }
}

async function interruptWork(
  ctx: MutationCtx,
  orchestrator: Doc<"aiOrchestrators">,
  work: Doc<"aiOrchestratorWork">,
  threadId: string,
) {
  const scope = work.companyId
    ? await orchestratorOwnerScope(ctx, orchestrator, work.companyId)
    : null;
  if (!scope || !hasCompanyPermission(scope.permissions, "remoteAgents.control")) return;
  const now = Date.now();
  const project =
    work.projectId === null
      ? null
      : await ctx.db
          .query("cloudProjects")
          .withIndex("by_company_and_domain_id", (q) =>
            q.eq("companyId", scope.company._id).eq("id", work.projectId!),
          )
          .unique();
  const id = mintDomainId(now);
  const commandDocId = await ctx.db.insert("environmentCommands", {
    id,
    companyId: scope.company._id,
    targetEnvironmentId: work.environmentId,
    cloudProjectId: project?._id ?? null,
    bindingId: null,
    kind: "interrupt",
    args: {
      kind: "interrupt",
      threadId,
      ...(work.continuation
        ? { messageId: work.resultMessageId ?? `${work.commandId}:message` }
        : {}),
    },
    issuedByMembershipId: scope.membership._id,
    onBehalfOfActor: { kind: "member", membershipId: scope.membership.id },
    state: "pending",
    claimedByEnvironmentId: null,
    claimGeneration: 0,
    claimExpiresAt: null,
    expiresAt: now + 24 * 60 * 60 * 1000,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  });
  const command = (await ctx.db.get(commandDocId))!;
  await appendCompanyChanges(ctx, {
    companyId: scope.company._id,
    actor: command.onBehalfOfActor,
    changes: [
      {
        entityKind: "environmentCommand",
        entityId: id,
        changeKind: "upsert",
        versionDocId: commandDocId,
        payload: await encodeEnvironmentCommand(ctx, command),
      },
    ],
  });
  await ctx.db.patch(work._id, { interruptCommandId: id, updatedAt: now });
}

/** Cancellation of a queued command proves it never started; accepted work needs a stop receipt. */
export async function requestOrchestratorStop(
  ctx: MutationCtx,
  orchestrator: Doc<"aiOrchestrators">,
  onlyWorkId?: string,
) {
  const batches = await Promise.all(
    (["queued", "working", "unknown"] as const).map((status) =>
      ctx.db
        .query("aiOrchestratorWork")
        .withIndex("by_orchestrator_status", (q) =>
          q.eq("orchestratorId", orchestrator.id).eq("status", status),
        )
        .take(100),
    ),
  );
  const pendingRoots = onlyWorkId
    ? []
    : await ctx.db
        .query("aiOrchestratorWork")
        .withIndex("by_orchestrator_controls", (q) =>
          q.eq("orchestratorId", orchestrator.id).eq("controlsPending", true),
        )
        .collect();
  const roots = onlyWorkId
    ? []
    : (await resolveWorkAssignments(ctx, batches.flat())).map(({ assignment }) => assignment);
  const rows = new Map(
    [...batches.flat(), ...pendingRoots, ...roots].map((work) => [work.id, work]),
  );
  if (onlyWorkId) {
    const selected = await ctx.db
      .query("aiOrchestratorWork")
      .withIndex("by_domain_id", (q) => q.eq("id", onlyWorkId))
      .unique();
    rows.clear();
    if (selected && selected.orchestratorId === orchestrator.id) rows.set(selected.id, selected);
  }
  for (const work of rows.values()) {
    if (onlyWorkId && work.id !== onlyWorkId) continue;
    await cancelPendingWorkerMessages(ctx, work.id);
    const now = Date.now();

    let unstarted = !work.commandId;
    if (work.companyId && work.commandId) {
      const scope = await orchestratorOwnerScope(ctx, orchestrator, work.companyId);
      const command = scope
        ? await ctx.db
            .query("environmentCommands")
            .withIndex("by_company_and_domain_id", (q) =>
              q.eq("companyId", scope.company._id).eq("id", work.commandId!),
            )
            .unique()
        : null;
      if (command?.state === "pending") {
        const patch = {
          state: "canceled" as const,
          error: "Stop requested through the orchestrator.",
          updatedAt: now,
        };
        await ctx.db.patch(command._id, patch);
        unstarted = true;
        await appendCompanyChanges(ctx, {
          companyId: command.companyId,
          actor: command.onBehalfOfActor,
          changes: [
            {
              entityKind: "environmentCommand",
              entityId: command.id,
              changeKind: "upsert",
              versionDocId: command._id,
              payload: await encodeEnvironmentCommand(ctx, { ...command, ...patch }),
            },
          ],
        });
      }
    }
    // A separately accepted follow-up may outlive an unclaimed initial dispatch.
    if (
      unstarted &&
      (await ctx.db
        .query("aiOrchestratorWorkerMessages")
        .withIndex("by_work_state", (q) => q.eq("workId", work.id).eq("state", "accepted"))
        .first())
    )
      unstarted = false;
    await ctx.db.patch(work._id, {
      stopRequested: true,
      stopConfirmed: unstarted,
      controlsPending: !unstarted,
      status: unstarted ? "cancelled" : "unknown",
      detail: unstarted
        ? "Cancelled before starting."
        : "Stop requested. Waiting for the environment to confirm interruption.",
      updatedAt: now,
    });
    if (!unstarted && !work.controlsPending && work.threadId && !work.interruptCommandId)
      await interruptWork(ctx, orchestrator, work, work.threadId);
  }
}

/** Redirects only work whose old command is provably unclaimed, in the same transaction. */
export async function controlOrchestratorWork(
  ctx: MutationCtx,
  orchestrator: Doc<"aiOrchestrators">,
  chat: Doc<"aiOrchestratorChats">,
  action: Extract<OrchestratorAction, { kind: "stopWork" | "redirectWork" }>,
) {
  if (!orchestrator.capabilities.includes("threads.control"))
    return fail("This orchestrator cannot control worker threads.");
  const work = await ctx.db
    .query("aiOrchestratorWork")
    .withIndex("by_domain_id", (q) => q.eq("id", action.workId))
    .unique();
  if (
    !work ||
    work.orchestratorId !== orchestrator.id ||
    work.chatId !== chat.id ||
    !work.companyId
  )
    return fail("Choose this orchestrator's assignment in the current conversation.");
  const scope = await orchestratorOwnerScope(ctx, orchestrator, work.companyId);
  if (
    !scope ||
    !hasCompanyPermission(scope.permissions, "remoteAgents.control") ||
    (orchestrator.projectId && orchestrator.projectId !== work.projectId)
  )
    return fail("This assignment is outside the orchestrator's current control permission.");
  if (action.kind === "stopWork") {
    await cancelPendingWorkerMessages(ctx, work.id);
    const followups = await Promise.all(
      (["queued", "working", "unknown"] as const).map((status) =>
        ctx.db
          .query("aiOrchestratorWork")
          .withIndex("by_control_work_status", (q) =>
            q.eq("controlWorkId", work.id).eq("status", status),
          )
          .take(100),
      ),
    );
    for (const followup of followups.flat())
      await requestOrchestratorStop(ctx, orchestrator, followup.id);
    if (["completed", "failed", "cancelled"].includes(work.status)) {
      await ctx.db.patch(work._id, { stopRequested: true, updatedAt: Date.now() });
      return {
        workId: work.id,
        detail:
          "This worker is finished. Stop has also been requested for any remaining descendants; their interruption is not yet confirmed.",
      };
    }
    await requestOrchestratorStop(ctx, orchestrator, work.id);
    const stopped = (await ctx.db.get(work._id))!;
    return { workId: work.id, detail: stopped.detail };
  }
  const command = work.commandId
    ? await ctx.db
        .query("environmentCommands")
        .withIndex("by_company_and_domain_id", (q) =>
          q.eq("companyId", scope.company._id).eq("id", work.commandId!),
        )
        .unique()
    : null;
  if (work.status !== "queued" || work.threadId || (work.commandId && command?.state !== "pending"))
    return fail(
      "Accepted or uncertain work cannot be redirected. Confirm it stopped before assigning replacement work.",
    );
  if (work.environmentId === action.environmentId)
    return { workId: work.id, detail: "The assignment is already queued on that environment." };
  await requestOrchestratorStop(ctx, orchestrator, work.id);
  const replacement = await queueOrchestratorWork(ctx, orchestrator, chat, {
    kind: "delegate",
    title: work.title,
    companyId: work.companyId,
    projectId: work.projectId,
    environmentId: action.environmentId,
    prompt: work.prompt,
    selection:
      work.selectionExplicit !== false && work.selection ? decodeSelection(work.selection) : null,
    ...(work.selectionExplicit !== false && work.selectionReason
      ? { selectionReason: work.selectionReason }
      : {}),
  });
  await ctx.db.patch(work._id, {
    detail: "Cancelled before starting and redirected to another environment.",
  });
  return {
    workId: replacement.workId,
    replacedWorkId: work.id,
    detail:
      replacement.status === "failed"
        ? replacement.detail
        : "The previous command was cancelled before acceptance. Replacement work is queued under the same conversation limits.",
  };
}

async function cancelPendingWorkerMessages(ctx: MutationCtx, workId: string) {
  const messages = await ctx.db
    .query("aiOrchestratorWorkerMessages")
    .withIndex("by_work_state", (q) => q.eq("workId", workId).eq("state", "pending"))
    .take(101);
  for (const message of messages) {
    await ctx.db.patch(message._id, {
      state: "removed",
      revision: message.revision + 1,
      detail: "Cancelled when this work was stopped.",
    });
    if (message.chatMessageId) {
      const visible = await ctx.db
        .query("aiOrchestratorMessages")
        .withIndex("by_domain_id", (q) => q.eq("id", message.chatMessageId!))
        .unique();
      if (visible) await ctx.db.patch(visible._id, { status: "cancelled" });
    }
  }
  const accepted = await ctx.db
    .query("aiOrchestratorWorkerMessages")
    .withIndex("by_work_state", (q) => q.eq("workId", workId).eq("state", "accepted"))
    .first();
  const work = await ctx.db
    .query("aiOrchestratorWork")
    .withIndex("by_domain_id", (q) => q.eq("id", workId))
    .unique();
  if (work) await ctx.db.patch(work._id, { controlsPending: !!accepted });
  const questions = await ctx.db
    .query("aiOrchestratorWorkerQuestions")
    .withIndex("by_work", (q) => q.eq("workId", workId))
    .order("desc")
    .take(100);
  for (const question of questions)
    if (["open", "escalated", "answering"].includes(question.state))
      await ctx.db.patch(question._id, { state: "unavailable" });
}
