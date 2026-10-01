// @effect-diagnostics preferSchemaOverJson:off - these tests construct and inspect the exact vendor wire format.
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue } from "effect";
import { TestClock } from "effect/testing";
import { make } from "./DeviceControl.ts";
import { makeDeviceInputChannel } from "./DeviceInputChannel.ts";
const target = { hostId: "local", deviceId: "phone" };
const owner = { kind: "viewer" as const, sessionId: "session", viewerId: "one" };
const tagged = (tag: number, body: unknown) =>
  Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(body))]);

it.effect("Android watchers keep reset-video, while held touches finish before hand-back", () =>
  Effect.gen(function* () {
    const control = yield* make();
    const writes = yield* Queue.unbounded<string | Uint8Array>();
    const writer = (frame: string | Uint8Array) => Queue.offer(writes, frame).pipe(Effect.asVoid);
    const watcher = yield* makeDeviceInputChannel(control, null, "android", writer);
    yield* watcher.input('{"type":"touch","action":"down","x":0.1,"y":0.2}');
    yield* watcher.input('{"type":"reset-video","ack":true}');
    expect(yield* Queue.take(writes)).toBe('{"type":"reset-video","ack":false}');
    expect(yield* Queue.size(writes)).toBe(0);
    const state = yield* control.acquire(target, owner);
    const grant = { ...target, owner, generation: state.generation };
    const channel = yield* makeDeviceInputChannel(control, grant, "android", writer);
    const down = yield* channel
      .input('{"type":"touch","action":"down","x":0.1,"y":0.2}')
      .pipe(Effect.forkChild);
    expect(JSON.parse(String(yield* Queue.take(writes)))).toMatchObject({
      action: "down",
      ack: true,
    });
    yield* channel.receipt('{"ok":true}');
    yield* Fiber.join(down);
    let released = false;
    const release = yield* control.release(grant).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          released = true;
        }),
      ),
      Effect.forkChild,
    );
    expect(JSON.parse(String(yield* Queue.take(writes)))).toEqual({
      type: "touch",
      action: "up",
      x: 0.1,
      y: 0.2,
      ack: true,
    });
    expect(released).toBe(false);
    yield* channel.receipt('{"ok":true}');
    yield* Fiber.join(release);
    yield* channel.input('{"type":"touch","action":"move","x":0.9,"y":0.9}');
    expect(yield* Queue.size(writes)).toBe(0);
    expect(yield* channel.receipt(new Uint8Array([83, 69, 77, 85]))).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect(
  "iOS takeover drains a held key and correlates receipts without swallowing video/config",
  () =>
    Effect.gen(function* () {
      const control = yield* make();
      const writes = yield* Queue.unbounded<Uint8Array>();
      const state = yield* control.acquire(target, owner);
      const channel = yield* makeDeviceInputChannel(
        control,
        { ...target, owner, generation: state.generation },
        "ios",
        (frame) => Queue.offer(writes, frame as Uint8Array).pipe(Effect.asVoid),
      );
      const down = yield* channel
        .input(tagged(6, { type: "down", usage: 42 }))
        .pipe(Effect.forkChild);
      const packet = yield* Queue.take(writes);
      expect(packet[0]).toBe(126);
      const first = JSON.parse(Buffer.from(packet.subarray(1)).toString());
      expect(yield* channel.receipt(tagged(130, { width: 100 }))).toBe(false);
      yield* channel.receipt(tagged(254, { id: first.id, ok: true }));
      yield* Fiber.join(down);
      const takeover = yield* control
        .acquire(target, { ...owner, viewerId: "two" })
        .pipe(Effect.forkChild);
      const next = JSON.parse(Buffer.from((yield* Queue.take(writes)).subarray(1)).toString());
      expect(JSON.parse(Buffer.from(next.packet, "base64").subarray(1).toString())).toEqual({
        type: "up",
        usage: 42,
      });
      yield* channel.receipt(tagged(254, { id: next.id, ok: true }));
      expect((yield* Fiber.join(takeover)).owner).toEqual({ ...owner, viewerId: "two" });
      yield* channel.input(tagged(6, { type: "down", usage: 42 }));
      expect(yield* Queue.size(writes)).toBe(0);
    }).pipe(Effect.scoped),
);

it.effect("missing completion receipts keep takeover fenced even after the input timeout", () =>
  Effect.gen(function* () {
    const control = yield* make();
    const sent = yield* Deferred.make<void>();
    const held = yield* control.acquire(target, owner);
    const channel = yield* makeDeviceInputChannel(
      control,
      { ...target, owner, generation: held.generation },
      "android",
      () => Deferred.succeed(sent, undefined).pipe(Effect.asVoid),
    );
    const input = yield* channel.input('{"type":"back"}').pipe(Effect.forkChild);
    yield* Deferred.await(sent);
    yield* TestClock.adjust(10_000);
    yield* Fiber.join(input);
    expect(
      (yield* control.acquire(target, { ...owner, viewerId: "two" }).pipe(Effect.flip)).code,
    ).toBe("input_unconfirmed");
  }).pipe(Effect.scoped),
);

for (const takeover of [false, true]) {
  it.effect(
    `Android ${takeover ? "takeover" : "hand-back"} finishes every remaining pointer with its latest coordinates`,
    () =>
      Effect.gen(function* () {
        const control = yield* make();
        const state = yield* control.acquire(target, owner);
        const grant = { ...target, owner, generation: state.generation };
        const writes = yield* Queue.unbounded<string | Uint8Array>();
        const channel = yield* makeDeviceInputChannel(control, grant, "android", (frame) =>
          Queue.offer(writes, frame).pipe(Effect.asVoid),
        );
        const send = (frame: object) =>
          Effect.gen(function* () {
            const sent = yield* channel.input(JSON.stringify(frame)).pipe(Effect.forkChild);
            yield* Queue.take(writes);
            yield* channel.receipt('{"ok":true}');
            yield* Fiber.join(sent);
          });
        yield* send({ type: "touch", action: "down", x: 0.1, y: 0.1, pointerId: 1 });
        yield* send({ type: "touch", action: "down", x: 0.2, y: 0.2, pointerId: 2 });
        yield* send({ type: "touch", action: "move", x: 0.3, y: 0.4, pointerId: 1 });
        yield* send({ type: "touch", action: "up", x: 0.2, y: 0.2, pointerId: 2 });
        // Omitted pointerId and explicit zero are the same vendor pointer.
        yield* send({ type: "touch", action: "down", x: 0.5, y: 0.5 });
        yield* send({ type: "touch", action: "move", x: 0.6, y: 0.7, pointerId: 0 });
        let acknowledged = false;
        const release = yield* (
          takeover ? control.acquire(target, { ...owner, viewerId: "two" }) : control.release(grant)
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              acknowledged = true;
            }),
          ),
          Effect.forkChild,
        );
        for (const expected of [
          { type: "touch", action: "up", x: 0.3, y: 0.4, pointerId: 1, ack: true },
          { type: "touch", action: "up", x: 0.6, y: 0.7, pointerId: 0, ack: true },
        ]) {
          expect(JSON.parse(String(yield* Queue.take(writes)))).toEqual(expected);
          expect(acknowledged).toBe(false);
          yield* channel.receipt('{"ok":true}');
        }
        yield* Fiber.join(release);
        expect(acknowledged).toBe(true);
        expect(yield* Queue.size(writes)).toBe(0);
      }).pipe(Effect.scoped),
  );
}
