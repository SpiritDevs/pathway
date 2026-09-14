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
) {
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
  const preset = (orchestrator.workerModels ?? []).find(
    (choice) => choice.environmentId === action.environmentId,
  );
  const selection = action.selection ?? preset?.selection ?? null;
  if (
    selection &&
    registration.orchestratorDelegationCatalog &&
    Date.now() - (registration.orchestratorDelegationCatalogAt ?? 0) <= 120000
  ) {
    const catalog = decodeCatalog(registration.orchestratorDelegationCatalog);
    const problem = delegationSelectionProblem(decodeSelection(selection), catalog);
    if (problem) return fail(`${problem} No fallback was selected.`);
  }
  const selectionReason = action.selection
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
  await ctx.db.insert("aiOrchestratorWork", {
    id,
    chatId: chat.id,
    orchestratorId: orchestrator.id,
    title: action.title.trim(),
    environmentId: action.environmentId,
    projectId: action.projectId,
    companyId: action.companyId,
    threadId: null,
    status: "queued",
    completionNotified: false,
    sourceSequence: chat.lastSequence,
    resultRequired: true,
    resultCollected: false,
    detail: "Waiting for a work slot.",
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
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return id;
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
      Option.isSome(shell) &&
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
    if (work.stopRequested && !["completed", "failed", "cancelled"].includes(status)) {
      status = "unknown";
      if (threadId && !work.interruptCommandId)
        await interruptWork(ctx, orchestrator, work, threadId);
      detail = offline
        ? "Stop requested. The offline environment has not confirmed interruption."
        : "Stop requested. Waiting for the delegated thread to confirm it stopped.";
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
      kind: "startThread" as const,
      args: { kind: "startThread", prompt: work.prompt, modelSelection: work.selection ?? null },
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
    args: { kind: "interrupt", threadId },
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
  for (const work of batches.flat()) {
    if (onlyWorkId && work.id !== onlyWorkId) continue;
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
    await ctx.db.patch(work._id, {
      stopRequested: true,
      status: unstarted ? "cancelled" : "unknown",
      detail: unstarted
        ? "Cancelled before starting."
        : "Stop requested. Waiting for the environment to confirm interruption.",
      updatedAt: now,
    });
    if (work.threadId && !work.interruptCommandId)
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
    selection: work.selection ? decodeSelection(work.selection) : null,
  });
  await ctx.db.patch(work._id, {
    detail: "Cancelled before starting and redirected to another environment.",
  });
  return {
    workId: replacement,
    replacedWorkId: work.id,
    detail:
      "The previous command was cancelled before acceptance. Replacement work is queued under the same conversation limits.",
  };
}
