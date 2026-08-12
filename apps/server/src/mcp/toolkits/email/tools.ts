import {
  EmailCaptureError,
  EmailGetResult,
  EmailListResult,
  EmailMcpCreateTaskResult,
  EmailMcpGetInput,
  EmailMcpLatestCodeInput,
  EmailMcpLatestCodeResult,
  EmailMcpListInput,
  EmailMcpLongPollResult,
  EmailMcpWaitForInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { EmailMcpService } from "./EmailMcpService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, EmailMcpService];

const readonlyTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true) as T;

export const EmailWaitForTool = readonlyTool(
  Tool.make("email_wait_for", {
    description:
      "Wait for captured email matching sender, subject, or recipient. Defaults to this thread's project; pass a project mail slug or 'all' to widen. Clients without MCP task support use a bounded long-poll (120 seconds by default).",
    parameters: EmailMcpWaitForInput,
    success: Schema.Union([EmailMcpCreateTaskResult, EmailMcpLongPollResult]),
    failure: EmailCaptureError,
    dependencies,
  }).annotate(Tool.Title, "Wait for email"),
);

export const EmailLatestCodeTool = readonlyTool(
  Tool.make("email_latest_code", {
    description:
      "Return the newest detected 4-8 character verification code, its sender, and its age. Defaults to this thread's project; pass a project mail slug or 'all' to widen.",
    parameters: EmailMcpLatestCodeInput,
    success: Schema.NullOr(EmailMcpLatestCodeResult),
    failure: EmailCaptureError,
    dependencies,
  }).annotate(Tool.Title, "Get latest email code"),
);

export const EmailListTool = readonlyTool(
  Tool.make("email_list", {
    description:
      "List captured email newest-first with sender, subject, recipient and read-state filters. Defaults to this thread's project; pass a project mail slug or 'all' to widen.",
    parameters: EmailMcpListInput,
    success: EmailListResult,
    failure: EmailCaptureError,
    dependencies,
  }).annotate(Tool.Title, "List captured email"),
);

export const EmailGetTool = readonlyTool(
  Tool.make("email_get", {
    description:
      "Read one captured email by id, including text, HTML, headers, attachments, links represented in the body, capture metadata, and detected code. Access defaults to this thread's project.",
    parameters: EmailMcpGetInput,
    success: EmailGetResult,
    failure: EmailCaptureError,
    dependencies,
  }).annotate(Tool.Title, "Read captured email"),
);

export const EmailToolkit = Toolkit.make(
  EmailWaitForTool,
  EmailLatestCodeTool,
  EmailListTool,
  EmailGetTool,
);
