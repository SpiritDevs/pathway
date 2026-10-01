/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker messages do not have browser origins. */
// @effect-diagnostics nodeBuiltinImport:off -- An isolated worker keeps SRP/hashcash CPU and library globals off the server event loop.
import * as NodeModule from "node:module";
import * as NodeWorkerThreads from "node:worker_threads";
import * as Schema from "effect/Schema";
import { AppleError } from "@spiritdevs/contracts/apple";
import type { AppleCookieHttp } from "./AppleIdProtocol.ts";

const resultSchema = Schema.Struct({
  isTFAEnabled: Schema.Boolean,
  scnt: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
});
const messageSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("result"), result: resultSchema }),
  Schema.Struct({ type: Schema.Literal("error") }),
  Schema.Struct({
    type: Schema.Literal("http"),
    id: Schema.Int,
    url: Schema.String,
    method: Schema.String,
    headers: Schema.Record(Schema.String, Schema.String),
    body: Schema.optional(Schema.String),
  }),
]);
// Low-level attemptLoginRequestAsync performs SRP only. The CLI's interactive login,
// cookie files, Keychain functions, global cookie jar and team prompts are never used.
const source = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { Auth, getRequestClient } = require(workerData.modulePath);
let nextId = 0;
const pending = new Map();
parentPort.on("message", message => {
  const deferred = pending.get(message.id);
  if (!deferred) return;
  pending.delete(message.id);
  if (message.error) deferred.reject(new Error("Apple request failed"));
  else deferred.resolve(message.response);
});
getRequestClient().defaults.adapter = async config => {
  const id = ++nextId;
  const response = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: "http", id, url: new URL(config.url, config.baseURL).href,
      method: config.method || "get", headers: config.headers || {},
      ...(typeof config.data === "string" ? { body: config.data } : {}) });
  });
  return { ...response, config };
};
Auth.attemptLoginRequestAsync({ username: workerData.email, password: workerData.password },
  { authServiceUrl: "https://idmsa.apple.com/appleauth/", authServiceKey: workerData.key })
  .then(result => parentPort.postMessage({ type: "result", result }),
        () => parentPort.postMessage({ type: "error" }));
`;
export function srpExchange(
  email: string,
  password: string,
  key: string,
  client: AppleCookieHttp,
  signal: AbortSignal,
): Promise<typeof resultSchema.Type> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new NodeWorkerThreads.Worker(source, {
      eval: true,
      workerData: {
        modulePath: NodeModule.createRequire(import.meta.url).resolve("@expo/apple-utils"),
        email,
        password,
        key,
      },
      env: {},
      stdout: true,
      stderr: true,
    });
    let settled = false;
    const finish = (result?: typeof resultSchema.Type) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      void worker.terminate();
      if (result) resolve(result);
      else
        reject(
          new AppleError({
            code: signal.aborted ? "credential-changed" : "unauthorized",
            message: signal.aborted
              ? "Apple sign-in was cancelled or expired."
              : "Apple rejected sign-in. Check the account credentials and try again.",
            retryAfterSeconds: null,
          }),
        );
    };
    const abort = () => finish();
    signal.addEventListener("abort", abort, { once: true });
    worker.stdout.resume();
    worker.stderr.resume();
    worker.on("error", () => finish());
    worker.on("exit", () => finish());
    worker.on("message", (raw: unknown) => {
      if (settled) return;
      let message: typeof messageSchema.Type;
      try {
        message = Schema.decodeUnknownSync(messageSchema)(raw);
      } catch {
        finish();
        return;
      }
      if (message.type === "error") {
        finish();
        return;
      }
      if (message.type === "result") {
        finish(message.result);
        return;
      }
      const request = message;
      void (async () => {
        try {
          const response = await client.request(request.url, {
            method: request.method,
            headers: request.headers,
            signal,
            ...(request.body === undefined ? {} : { body: request.body }),
          });
          const raw = await response.text();
          let data: unknown = raw;
          try {
            data = JSON.parse(raw) as unknown;
          } catch {
            /* Sign-in bootstrap can be HTML. */
          }
          if (!settled)
            worker.postMessage({
              id: request.id,
              response: {
                data,
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries()),
              },
            });
        } catch {
          if (!settled) worker.postMessage({ id: request.id, error: true });
        }
      })();
    });
    if (signal.aborted) finish();
  });
}
