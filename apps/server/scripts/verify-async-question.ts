// Opt-in live verification against an already running isolated loopback environment.
// Requires PATHWAY_VERIFY_ORIGIN, PATHWAY_VERIFY_PAIR_FILE, PATHWAY_VERIFY_THREAD.
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off - Explicit protocol verification.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import {
  AuthBrowserSessionResult,
  AuthWebSocketTicketResult,
  CommandId,
  ORCHESTRATION_V2_WS_METHODS as methods,
  ThreadId,
  WsRpcGroup,
} from "@spiritdevs/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

const origin = new URL(process.env.PATHWAY_VERIFY_ORIGIN ?? "");
NodeAssert.ok(
  ["127.0.0.1", "localhost"].includes(origin.hostname),
  "Use an isolated loopback environment.",
);
const threadId = ThreadId.make(process.env.PATHWAY_VERIFY_THREAD ?? "");
NodeAssert.ok(threadId.length > 0);
const pairingOutput = await NodeFSP.readFile(process.env.PATHWAY_VERIFY_PAIR_FILE ?? "", "utf8");
const token = pairingOutput.match(/\/pair#token=([^\s]+)/)?.[1];
NodeAssert.ok(token, "Pairing CLI output must contain a freshly minted token.");
const paired = await fetch(new URL("/api/auth/browser-session", origin), {
  method: "POST",
  headers: { "content-type": "application/json", origin: origin.origin },
  body: JSON.stringify({ credential: token }),
});
NodeAssert.equal(paired.status, 200, "Local pairing failed.");
Schema.decodeUnknownSync(Schema.toCodecJson(AuthBrowserSessionResult))(await paired.json());
const cookie = paired.headers
  .getSetCookie()
  .map((value) => value.split(";", 1)[0])
  .join("; ");
NodeAssert.ok(cookie.length > 0, "No authenticated session cookie returned.");
const ticketResponse = await fetch(new URL("/api/auth/websocket-ticket", origin), {
  method: "POST",
  headers: { cookie, origin: origin.origin },
});
NodeAssert.equal(ticketResponse.status, 200, "WebSocket ticket issuance failed.");
const ticket = Schema.decodeUnknownSync(Schema.toCodecJson(AuthWebSocketTicketResult))(
  await ticketResponse.json(),
);
const socketUrl = new URL("/ws", origin);
socketUrl.protocol = "ws:";
socketUrl.searchParams.set("wsTicket", ticket.ticket);
const protocol = Layer.effect(
  RpcClient.Protocol,
  RpcClient.makeProtocolSocket({ retryTransientErrors: false }),
).pipe(
  Layer.provide(
    Layer.merge(
      Socket.layerWebSocket(socketUrl.href).pipe(
        Layer.provide(Socket.layerWebSocketConstructorGlobal),
      ),
      RpcSerialization.layerJson,
    ),
  ),
);
const result = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(WsRpcGroup);
      const before = yield* client[methods.getThreadProjection]({ threadId });
      const questionItem = before.turnItems.find(
        (item) =>
          item.type === "user_input_request" &&
          item.questions.some((question) => question.question === "Which verification colour?"),
      );
      NodeAssert.ok(questionItem?.type === "user_input_request");
      const request = before.runtimeRequests.find(
        (request) => request.id === questionItem.requestId,
      );
      NodeAssert.equal(
        request?.status,
        "pending",
        "Question must be unanswered before this explicit verification.",
      );
      NodeAssert.equal(request?.responseCapability.type, "message");
      NodeAssert.ok(
        before.runs.every((run) => ["completed", "failed", "cancelled"].includes(run.status)),
        "Originating run must already be finished.",
      );
      const ready = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      const observed: Array<{ sequence: number; type: string }> = [];
      yield* client[methods.subscribeThread]({ threadId }).pipe(
        Stream.runForEach((item) =>
          Effect.gen(function* () {
            if (item.kind === "snapshot") yield* Deferred.succeed(ready, undefined);
            if (item.kind !== "event") return;
            observed.push({ sequence: item.sequence, type: item.event.type });
            if (
              item.event.type === "run.updated" &&
              item.event.payload.ordinal > before.runs.length &&
              ["completed", "failed", "cancelled"].includes(item.event.payload.status)
            ) {
              yield* Deferred.succeed(completed, undefined);
            }
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(ready);
      const command = {
        type: "runtime-request.respond" as const,
        commandId: CommandId.make(`verify:async-answer:${request!.id}`),
        threadId,
        requestId: request!.id,
        answers: { "question-1": "Blue" },
      };
      const receipt = yield* client[methods.dispatchCommand](command);
      yield* Deferred.await(completed);
      const duplicateReceipt = yield* client[methods.dispatchCommand](command);
      const after = yield* client[methods.getThreadProjection]({ threadId });
      const resolved = after.runtimeRequests.find((candidate) => candidate.id === request!.id);
      const answers = after.messages.filter(
        (message) => message.id === resolved?.responseMessageId,
      );
      NodeAssert.equal(resolved?.status, "resolved");
      NodeAssert.equal(after.runs.length, before.runs.length + 1);
      NodeAssert.equal(after.runs.at(-1)?.status, "completed");
      NodeAssert.equal(after.runs.at(-1)?.providerThreadId, before.thread.activeProviderThreadId);
      NodeAssert.equal(answers.length, 1);
      NodeAssert.ok(answers[0]?.text.includes('"answer":"Blue"'));
      NodeAssert.deepEqual(duplicateReceipt, receipt);
      return {
        outcome: "passed",
        threadId,
        requestId: request!.id,
        commandId: command.commandId,
        receipt,
        duplicateReceipt,
        runCountBefore: before.runs.length,
        runCountAfter: after.runs.length,
        followUpRunId: after.runs.at(-1)?.id,
        originProviderThreadId: before.thread.activeProviderThreadId,
        answerMessageId: answers[0]?.id,
        answerText: answers[0]?.text,
        assistantMessages: after.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.text),
        observed,
      };
    }),
  ).pipe(Effect.provide(protocol), Effect.timeout("55 seconds")),
);
console.log(JSON.stringify(result, null, 2));
