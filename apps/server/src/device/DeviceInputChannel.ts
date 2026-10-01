import { DeviceControlError } from "@spiritdevs/contracts";
import { Deferred, Effect, Schema, Semaphore } from "effect";
import { controlError, type DeviceControl, type DeviceControlGrant } from "./DeviceControl.ts";

const Json = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decode = Schema.decodeUnknownOption(Json);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const tagged = (tag: number, value: unknown) => {
  const body = encoder.encode(JSON.stringify(value));
  const out = new Uint8Array(body.length + 1);
  out[0] = tag;
  out.set(body, 1);
  return out;
};
type Frame = string | Uint8Array;

/** Protocol-specific completion receipts; media frames pass through untouched. */
export const makeDeviceInputChannel = Effect.fn("DeviceInputChannel.make")(function* (
  control: DeviceControl,
  grant: DeviceControlGrant | null,
  platform: "ios" | "android",
  write: (frame: Frame) => Effect.Effect<void, import("effect/unstable/socket/Socket").SocketError>,
) {
  const lock = yield* Semaphore.make(1);
  let pending: { id: number; done: Deferred.Deferred<void, DeviceControlError> } | undefined;
  let serial = 0;
  let closed = false;
  const held = new Map<string, Frame>();
  const target = grant ?? { hostId: "local", deviceId: "unknown" };
  const send = Effect.fn("DeviceInputChannel.send")(function* (frame: Frame) {
    if (closed) return yield* controlError(target, "input_unconfirmed");
    const id = ++serial;
    const done = yield* Deferred.make<void, DeviceControlError>();
    pending = { id, done };
    const outgoing =
      platform === "ios"
        ? tagged(126, { id, packet: Buffer.from(frame).toString("base64") })
        : (() => {
            const value = decode(typeof frame === "string" ? frame : decoder.decode(frame));
            return value._tag === "Some" ? JSON.stringify({ ...value.value, ack: true }) : "";
          })();
    yield* write(outgoing).pipe(Effect.mapError(() => controlError(target, "input_unconfirmed")));
    yield* Deferred.await(done).pipe(
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(controlError(target, "input_unconfirmed")),
      }),
      Effect.ensuring(
        Effect.sync(() => {
          pending = undefined;
        }),
      ),
    );
  });
  const trackedSend = (frame: Frame) =>
    send(frame).pipe(Effect.tapError(() => control.uncertain(target)));
  const finish = lock.withPermit(
    Effect.gen(function* () {
      for (const [key, frame] of held) {
        yield* trackedSend(frame);
        held.delete(key);
      }
    }),
  );
  if (grant && (yield* control.onFinish(grant, finish).pipe(Effect.result))._tag === "Failure")
    grant = null;
  const observeHeld = (frame: Frame) => {
    if (platform === "ios") {
      if (typeof frame === "string") return;
      const parsed = decode(decoder.decode(frame.subarray(1)));
      if (parsed._tag === "None") return;
      const value = parsed.value;
      if (frame[0] === 3 || frame[0] === 5) {
        const name = String(frame[0]);
        if (value.type === "end") held.delete(name);
        else if (value.type === "begin" || value.type === "move")
          held.set(name, tagged(frame[0], { ...value, type: "end" }));
      } else if (frame[0] === 6) {
        const name = `key:${value.usage}`;
        if (value.type === "up") held.delete(name);
        else if (value.type === "down") held.set(name, tagged(6, { ...value, type: "up" }));
      } else if (frame[0] === 4 && value.phase === "down")
        held.set(`button:${value.page}:${value.usage}`, tagged(4, { ...value, phase: "up" }));
      else if (frame[0] === 4 && value.phase === "up")
        held.delete(`button:${value.page}:${value.usage}`);
    } else {
      const parsed = decode(typeof frame === "string" ? frame : decoder.decode(frame));
      if (parsed._tag === "None") return;
      const value = parsed.value;
      if (value.type === "touch") {
        if (value.action === "up") held.delete("touch");
        else if (value.action === "down" || value.action === "move")
          held.set("touch", JSON.stringify({ ...value, action: "up" }));
      } else if (value.type === "key") {
        const name = `key:${value.keycode}`;
        if (value.action === "up") held.delete(name);
        else if (value.action === "down")
          held.set(name, JSON.stringify({ ...value, action: "up" }));
      }
    }
  };
  return {
    input: (frame: Frame) => {
      if (platform === "android") {
        const parsed = decode(typeof frame === "string" ? frame : decoder.decode(frame));
        if (parsed._tag === "Some" && parsed.value.type === "reset-video")
          return write(JSON.stringify({ type: "reset-video", ack: false })).pipe(Effect.ignore);
      }
      if (!grant) return Effect.void;
      if (
        platform === "ios" &&
        (typeof frame === "string" ||
          ![3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].includes(frame[0] ?? -1))
      )
        return Effect.void;
      return lock
        .withPermit(
          control.run(
            grant,
            Effect.sync(() => observeHeld(frame)).pipe(Effect.andThen(trackedSend(frame))),
          ),
        )
        .pipe(
          // Reject input only: Android carries video on this same connection.
          Effect.catchTag("DeviceControlError", () => Effect.void),
        );
    },
    receipt: (frame: Frame) =>
      Effect.sync(() => {
        const iosReceipt = platform === "ios" && typeof frame !== "string" && frame[0] === 254;
        const parsed = decode(
          iosReceipt && typeof frame !== "string"
            ? decoder.decode(frame.subarray(1))
            : typeof frame === "string"
              ? frame
              : "",
        );
        if (
          parsed._tag === "None" ||
          typeof parsed.value.ok !== "boolean" ||
          (platform === "ios" && !iosReceipt)
        )
          return false;
        if (pending && (platform === "android" || parsed.value.id === pending.id))
          Deferred.doneUnsafe(
            pending.done,
            parsed.value.ok ? Effect.void : Effect.fail(controlError(target, "input_unconfirmed")),
          );
        return true;
      }),
    disconnected: Effect.sync(() => {
      closed = true;
      if (pending)
        Deferred.doneUnsafe(pending.done, Effect.fail(controlError(target, "input_unconfirmed")));
    }),
    release: grant ? control.release(grant).pipe(Effect.ignore) : Effect.void,
  };
});
