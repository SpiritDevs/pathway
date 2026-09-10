/** Bounds and structural validation for cloud-stored user intent (no Effect runtime in Convex). */
import type { ChatAttachment } from "@spiritdevs/contracts";
import type { ThreadQueueSubmission } from "@spiritdevs/contracts/threadQueue";

const MAX_SUBMISSION_BYTES = 512 * 1024;
export const THREAD_QUEUE_MAX_MESSAGES = 100;

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a submission object.");
  }
  return value as Record<string, unknown>;
}
function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() !== value || !value || value.length > 256) {
    throw new Error(`${label} must be a non-empty identifier.`);
  }
}
export function validateAttachment(value: unknown): ChatAttachment {
  const item = object(value);
  identifier(item.id, "Attachment id");
  if (!/^[a-z0-9_-]+$/i.test(item.id) || item.id.length > 128)
    throw new Error("Invalid attachment id.");
  if (item.type !== "image" && item.type !== "file")
    throw new Error("Unsupported attachment type.");
  if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 255)
    throw new Error("Invalid attachment name.");
  if (
    typeof item.mimeType !== "string" ||
    !/^[^\s/]+\/[^\s/]+$/.test(item.mimeType) ||
    item.mimeType.length > 100
  )
    throw new Error("Invalid attachment media type.");
  if (item.type === "image" && !item.mimeType.startsWith("image/"))
    throw new Error("Invalid image media type.");
  const maximum = (item.type === "image" ? 10 : 50) * 1024 * 1024;
  if (
    typeof item.sizeBytes !== "number" ||
    !Number.isSafeInteger(item.sizeBytes) ||
    item.sizeBytes < 0 ||
    item.sizeBytes > maximum
  )
    throw new Error("Attachment size exceeds its limit.");
  return value as ChatAttachment;
}
export function submissionMessage(submission: ThreadQueueSubmission) {
  const message = submission.kind === "launch" ? submission.input.initialMessage : submission.input;
  if (!message?.messageId) throw new Error("Queued messages require a stable message id.");
  return message as typeof message & { messageId: string };
}
export function decodeQueueSubmission(value: unknown, threadId: string): ThreadQueueSubmission {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_SUBMISSION_BYTES)
    throw new Error("Submission exceeds its size limit; upload attachments separately.");
  const submission = object(value);
  if (submission.kind !== "launch" && submission.kind !== "message")
    throw new Error("Unknown submission kind.");
  identifier(threadId, "Thread id");
  const input = object(submission.input);
  identifier(input.commandId, "Command id");
  if (input.threadId !== threadId)
    throw new Error("The submission thread identity must match the queue.");
  if (input.createdBy !== undefined && input.createdBy !== "user")
    throw new Error("Only user messages can be queued.");
  if (
    input.creationSource !== undefined &&
    !["web", "mobile"].includes(String(input.creationSource))
  )
    throw new Error("Invalid submission surface.");
  if (submission.kind === "launch") {
    if (input.runtimeMode === undefined || input.interactionMode === undefined)
      throw new Error("A thread launch requires runtime and interaction modes.");
    if (input.projectId !== null) identifier(input.projectId, "Project id");
    identifier(input.title, "Thread title");
    validateModelSelection(input.modelSelection);
    const strategy = object(input.workspaceStrategy);
    if (!["root", "worktree", "existing_worktree"].includes(String(strategy.type)))
      throw new Error("Invalid workspace strategy.");
    if (strategy.type === "worktree") identifier(strategy.baseRef, "Base reference");
    if (strategy.type === "existing_worktree") identifier(strategy.worktreePath, "Worktree path");
  } else if (
    input.type !== "message.dispatch" ||
    input.delegatedCompletion !== undefined ||
    input.replyToRuntimeRequestId !== undefined
  ) {
    throw new Error("Only ordinary user messages can be queued.");
  }
  if (
    submission.kind === "message" &&
    submission.branch !== undefined &&
    submission.branch !== null &&
    (typeof submission.branch !== "string" || submission.branch.length > 1024)
  )
    throw new Error("Invalid checkout branch.");
  if (input.modelSelection !== undefined) validateModelSelection(input.modelSelection);
  const runtimeMode = submission.kind === "launch" ? input.runtimeMode : submission.runtimeMode;
  const interactionMode =
    submission.kind === "launch" ? input.interactionMode : submission.interactionMode;
  if (
    runtimeMode !== undefined &&
    !["full-access", "approval-required", "auto", "auto-accept-edits"].includes(String(runtimeMode))
  )
    throw new Error("Invalid runtime mode.");
  if (interactionMode !== undefined && !["default", "plan"].includes(String(interactionMode)))
    throw new Error("Invalid interaction mode.");
  const message = object(submission.kind === "launch" ? input.initialMessage : input);
  identifier(message.messageId, "Message id");
  if (typeof message.text !== "string" || message.text.length > 120_000)
    throw new Error("Message text exceeds its limit.");
  if (!Array.isArray(message.attachments) || message.attachments.length > 8)
    throw new Error("Too many attachments.");
  const attachments = message.attachments.map(validateAttachment);
  if (new Set(attachments.map((item) => item.id)).size !== attachments.length)
    throw new Error("Attachment ids must be unique.");
  if (!message.text.trim() && attachments.length === 0)
    throw new Error("A queued message cannot be empty.");
  return value as ThreadQueueSubmission;
}
export function validateModelSelection(value: unknown) {
  const selection = object(value);
  identifier(selection.instanceId, "Provider instance");
  identifier(selection.model, "Model");
  return selection as { instanceId: string; model: string };
}
export function canonicalQueueJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalQueueJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalQueueJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** SHA-256 keeps the immutable request identity small without storing prompt text twice. */
export async function queueSubmissionFingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalQueueJson(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
