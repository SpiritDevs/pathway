import {
  DeviceOperationError,
  deviceSimulatorInputPacket,
  type DeviceInput,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { DeviceHostReady } from "./DeviceHost.ts";

const Reply = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
    ok: Schema.Boolean,
    error: Schema.optional(Schema.String),
  }),
);
const decodeReply = Schema.decodeUnknownSync(Reply);

/** The host's loopback/SSH-forwarded helper receives the input, never the client's machine. */
export const sendSimulatorInput = Effect.fn("sendSimulatorInput")(function* (
  ready: DeviceHostReady,
  deviceId: string,
  input: DeviceInput,
) {
  const url = new URL("/vendor/serve-sim/helper/ws", ready.hub.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("device", deviceId);
  yield* Effect.tryPromise({
    try: (signal) =>
      new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        const id = "input";
        let finished = false;
        const finish = (error?: unknown) => {
          if (finished) return;
          finished = true;
          signal.removeEventListener("abort", abort);
          socket.removeEventListener("open", onOpen);
          socket.removeEventListener("close", onClose);
          socket.removeEventListener("error", onError);
          socket.removeEventListener("message", onMessage);
          socket.close();
          if (error) reject(error);
          else resolve();
        };
        const abort = () => finish(new Error("Simulator input cancelled"));
        const onOpen = () => {
          try {
            socket.send(
              Buffer.concat([
                Buffer.from([0x12]),
                Buffer.from(JSON.stringify({ id, ...deviceSimulatorInputPacket(input) })),
              ]),
            );
          } catch (error) {
            finish(error);
          }
        };
        const onMessage = (message: MessageEvent) => {
          if (!(message.data instanceof ArrayBuffer)) return;
          const data = new Uint8Array(message.data);
          if (data[0] !== 0x12) return;
          try {
            const reply = decodeReply(new TextDecoder().decode(data.subarray(1)));
            if (reply.id === id)
              finish(reply.ok ? undefined : new Error(reply.error ?? "Native input failed"));
          } catch (error) {
            finish(error);
          }
        };
        const onError = () => finish(new Error("Simulator input connection failed"));
        const onClose = () => finish(new Error("Simulator input closed before acknowledgement"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        socket.addEventListener("open", onOpen);
        socket.addEventListener("message", onMessage);
        socket.addEventListener("error", onError);
        socket.addEventListener("close", onClose);
      }),
    catch: (cause) =>
      new DeviceOperationError({ operation: "input", reason: "request_failed", cause }),
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.catchTag("TimeoutError", (cause) =>
      Effect.fail(
        new DeviceOperationError({ operation: "input", reason: "request_failed", cause }),
      ),
    ),
  );
});
