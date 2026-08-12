import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { EmailMcpService } from "./EmailMcpService.ts";
import { EmailToolkit } from "./tools.ts";

const handlers = {
  // The current Effect transport cannot express CreateTaskResult. The v2 transport calls the same
  // service with tasksSupported=true after checking the per-request extension declaration.
  email_wait_for: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* EmailMcpService;
      return yield* service.waitFor(invocation, input, false);
    }),
  email_latest_code: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* EmailMcpService;
      return Option.getOrNull(yield* service.latestCode(invocation, input.project));
    }),
  email_list: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* EmailMcpService;
      const messages = yield* service.list(invocation, input);
      return {
        messages: messages.map((message) => ({
          id: message.id,
          attribution: message.attribution,
          from: message.parsedHeaders.from,
          to: message.parsedHeaders.to,
          subject: message.parsedHeaders.subject,
          textPreview: (message.textBody ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
          receivedAt: message.timings.messageReceivedAt,
          sizeBytes: message.sizeBytes,
          attachmentCount: message.attachments.length,
          isRead: message.isRead,
          detectedCode: message.detectedCode,
        })),
        inboxes: [],
        nextCursor: messages.length === (input.limit ?? 50) ? (messages.at(-1)?.id ?? null) : null,
      };
    }),
  email_get: (input) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* EmailMcpService;
      return { message: yield* service.get(invocation, input) };
    }),
} satisfies Parameters<typeof EmailToolkit.toLayer>[0];

export const EmailToolkitHandlersLive = EmailToolkit.toLayer(handlers);
