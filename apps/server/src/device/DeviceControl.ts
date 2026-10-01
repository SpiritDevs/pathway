import {
  DeviceControlError,
  type DeviceControlOwner,
  type DeviceControlProof,
  type DeviceControlState,
} from "@spiritdevs/contracts";
import { Clock, Context, Deferred, Effect, Scope, Semaphore } from "effect";

export const DEVICE_CONTROL_TTL = 30_000;
export interface DeviceControlTarget {
  readonly hostId: string;
  readonly deviceId: string;
}
export interface DeviceControlGrant extends DeviceControlTarget {
  readonly owner: DeviceControlOwner;
  readonly generation: number;
}
/** Set only by the authenticated RPC or MCP boundary, never by request payloads. */
export class DeviceControlCaller extends Context.Reference<
  | { readonly kind: "viewer"; readonly sessionId: string }
  | { readonly kind: "agent"; readonly threadId: string; readonly runId: string }
  | null
>("@spiritdevs/pathway/device/DeviceControlCaller", { defaultValue: () => null }) {}

export const controlError = (target: DeviceControlTarget, code: DeviceControlError["code"]) =>
  new DeviceControlError({
    ...target,
    code,
    message: {
      control_required: "Take control before sending device input.",
      control_held: "Another viewer or agent run controls this device.",
      stale_generation: "Device control changed. Acquire control again.",
      control_draining: "Previous device input is still finishing.",
      run_stopped: "The agent run has ended. Open the device from an active run.",
      invalid_grant: "The device command grant is no longer valid. Call device_open again.",
      input_unconfirmed:
        "Device input completion could not be confirmed. Restart device tools before taking control.",
    }[code],
  });
const key = (target: DeviceControlTarget) => JSON.stringify([target.hostId, target.deviceId]);
const sameOwner = (a: DeviceControlOwner | null, b: DeviceControlOwner) =>
  a?.kind === b.kind &&
  (a.kind === "viewer" && b.kind === "viewer"
    ? a.sessionId === b.sessionId && a.viewerId === b.viewerId
    : a.kind === "agent" && b.kind === "agent" && a.threadId === b.threadId && a.runId === b.runId);

interface Entry {
  state: DeviceControlState;
  lock: Semaphore.Semaphore;
  calls: Set<Deferred.Deferred<void>>;
  finish: Set<Effect.Effect<void, DeviceControlError>>;
  uncertain: Set<"hub" | "agent">;
}

/** Admission is synchronous with registration. Handoff fences first, then awaits every receipt. */
export const make = Effect.fn("DeviceControl.make")(function* (
  publish: (states: ReadonlyArray<DeviceControlState>) => Effect.Effect<void> = () => Effect.void,
) {
  const scope = yield* Scope.Scope;
  const clock = yield* Clock.Clock;
  const entries = new Map<string, Entry>();
  const stopped = new Set<string>();
  let generation = 0;
  const runKey = (threadId: string, runId: string) => JSON.stringify([threadId, runId]);
  const get = (target: DeviceControlTarget) => {
    let entry = entries.get(key(target));
    if (!entry) {
      entry = {
        state: { ...target, generation: ++generation, phase: "idle", owner: null, expiresAt: null },
        lock: Semaphore.makeUnsafe(1),
        calls: new Set(),
        finish: new Set(),
        uncertain: new Set(),
      };
      entries.set(key(target), entry);
    }
    return entry;
  };
  const changed = Effect.suspend(() => publish([...entries.values()].map((entry) => entry.state)));
  const check = (grant: DeviceControlGrant) => {
    const entry = get(grant);
    if (
      grant.owner.kind === "agent" &&
      stopped.has(runKey(grant.owner.threadId, grant.owner.runId))
    )
      return controlError(grant, "run_stopped");
    if (entry.uncertain.size) return controlError(grant, "input_unconfirmed");
    if (entry.state.phase === "draining") return controlError(grant, "control_draining");
    if (
      entry.state.generation !== grant.generation ||
      (entry.state.expiresAt ?? 0) <= clock.currentTimeMillisUnsafe()
    )
      return controlError(grant, "stale_generation");
    if (!sameOwner(entry.state.owner, grant.owner)) return controlError(grant, "control_held");
    return null;
  };
  const drain = Effect.fn("DeviceControl.drain")(function* (entry: Entry) {
    entry.state = { ...entry.state, generation: ++generation, phase: "draining", expiresAt: null };
    yield* changed;
    yield* Effect.forEach([...entry.calls], Deferred.await, { discard: true });
    // Finishing held touches/keys uses the old channel, without admitting new input.
    yield* Effect.forEach([...entry.finish], (finish) => finish, { discard: true });
    entry.finish.clear();
    if (entry.uncertain.size) return yield* controlError(entry.state, "input_unconfirmed");
    entry.state = { ...entry.state, owner: null, phase: "idle" };
    yield* changed;
  });
  const invalidate = (target: DeviceControlTarget) => {
    const entry = get(target);
    return entry.lock.withPermit(drain(entry)).pipe(Effect.uninterruptible);
  };
  const expire = Effect.fn("DeviceControl.expire")(function* (entry: Entry) {
    const deadline = entry.state.expiresAt!;
    yield* Effect.sleep(Math.max(0, deadline - clock.currentTimeMillisUnsafe())).pipe(
      Effect.andThen(
        entry.lock.withPermit(
          Effect.suspend(() => {
            if (entry.state.expiresAt !== deadline) return Effect.void;
            return drain(entry).pipe(Effect.ignore);
          }),
        ),
      ),
      Effect.forkIn(scope),
    );
  });
  const hold = Effect.fn("DeviceControl.hold")(function* (entry: Entry, owner: DeviceControlOwner) {
    entry.state = {
      ...entry.state,
      generation: ++generation,
      owner,
      phase: "held",
      expiresAt: clock.currentTimeMillisUnsafe() + DEVICE_CONTROL_TTL,
    };
    yield* expire(entry);
    yield* changed;
    return entry.state;
  });
  const acquire = (target: DeviceControlTarget, owner: DeviceControlOwner) => {
    const entry = get(target);
    return entry.lock
      .withPermit(
        Effect.gen(function* () {
          if (owner.kind === "agent") {
            if (stopped.has(runKey(owner.threadId, owner.runId)))
              return yield* controlError(target, "run_stopped");
            if (entry.state.phase === "draining")
              return yield* controlError(target, "control_draining");
            if (
              entry.state.owner &&
              (entry.state.expiresAt ?? 0) > clock.currentTimeMillisUnsafe()
            ) {
              if (!sameOwner(entry.state.owner, owner))
                return yield* controlError(target, "control_held");
              return entry.state;
            }
          }
          yield* drain(entry);
          return yield* hold(entry, owner);
        }),
      )
      .pipe(Effect.uninterruptible);
  };
  const renew = (grant: DeviceControlGrant) =>
    get(grant)
      .lock.withPermit(
        Effect.gen(function* () {
          const error = check(grant);
          if (error) return yield* error;
          const entry = get(grant);
          entry.state = {
            ...entry.state,
            expiresAt: clock.currentTimeMillisUnsafe() + DEVICE_CONTROL_TTL,
          };
          yield* expire(entry);
          yield* changed;
          return entry.state;
        }),
      )
      .pipe(Effect.uninterruptible);
  const release = (grant: DeviceControlGrant) =>
    get(grant)
      .lock.withPermit(
        Effect.gen(function* () {
          const error = check(grant);
          if (error) return yield* error;
          const entry = get(grant);
          yield* drain(entry);
          return entry.state;
        }),
      )
      .pipe(Effect.uninterruptible);
  const run = <A, E, R>(
    grant: DeviceControlGrant,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | DeviceControlError, R> =>
    Effect.suspend((): Effect.Effect<A, E | DeviceControlError, R> => {
      const error = check(grant);
      if (error) return Effect.fail(error);
      const entry = get(grant);
      const done = Deferred.makeUnsafe<void>();
      entry.calls.add(done);
      return effect.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            entry.calls.delete(done);
            Deferred.doneUnsafe(done, Effect.void);
          }),
        ),
        Effect.uninterruptible,
      );
    });
  const viewerGrant = (
    target: DeviceControlTarget,
    sessionId: string,
    proof: DeviceControlProof,
  ): DeviceControlGrant => ({
    ...target,
    generation: proof.generation,
    owner: { kind: "viewer", sessionId, viewerId: proof.viewerId },
  });
  const endWith = <A, E, R>(grant: DeviceControlGrant, effect: Effect.Effect<A, E, R>) => {
    const entry = get(grant);
    return entry.lock
      .withPermit(
        Effect.gen(function* () {
          const error = check(grant);
          if (error) return yield* error;
          yield* drain(entry);
          entry.state = { ...entry.state, phase: "draining" };
          yield* changed;
          return yield* effect.pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                entry.state = { ...entry.state, phase: entry.uncertain.size ? "draining" : "idle" };
                yield* changed;
              }),
            ),
          );
        }),
      )
      .pipe(Effect.uninterruptible);
  };
  const authorize = Effect.fn("DeviceControl.authorize")(function* (
    target: DeviceControlTarget,
    proof: DeviceControlProof | undefined,
  ) {
    const caller = yield* DeviceControlCaller;
    if (!caller) return yield* controlError(target, "control_required");
    if (caller.kind === "viewer") {
      if (!proof) return yield* controlError(target, "control_required");
      const grant = viewerGrant(target, caller.sessionId, proof);
      const error = check(grant);
      if (error) return yield* error;
      return grant;
    }
    const owner = {
      kind: "agent" as const,
      threadId: caller.threadId,
      runId: caller.runId,
    } as DeviceControlOwner;
    const state = yield* acquire(target, owner);
    return { ...target, owner, generation: state.generation };
  });
  const mutation = <A, E, R>(
    target: DeviceControlTarget,
    proof: DeviceControlProof | undefined,
    effect: Effect.Effect<A, E, R>,
  ) => authorize(target, proof).pipe(Effect.flatMap((grant) => run(grant, effect)));
  const invalidateWhere = (matches: (state: DeviceControlState) => boolean) =>
    Effect.suspend(() =>
      Effect.forEach(
        [...entries.values()].filter((entry) => matches(entry.state)),
        (entry) =>
          entry.lock
            .withPermit(Effect.suspend(() => (matches(entry.state) ? drain(entry) : Effect.void)))
            .pipe(Effect.uninterruptible),
        { concurrency: "unbounded", discard: true },
      ),
    );
  return {
    acquire,
    renew,
    release,
    run,
    mutation,
    authorize,
    endWith,
    viewerGrant,
    invalidate,
    state: Effect.sync(() => [...entries.values()].map((entry) => entry.state)),
    assert: (grant: DeviceControlGrant) =>
      Effect.suspend(() => {
        const error = check(grant);
        return error ? Effect.fail(error) : Effect.void;
      }),
    uncertain: (target: DeviceControlTarget, tool: "hub" | "agent" = "hub") =>
      Effect.gen(function* () {
        const entry = get(target);
        entry.uncertain.add(tool);
        entry.state = {
          ...entry.state,
          generation: ++generation,
          phase: "draining",
          expiresAt: null,
        };
        yield* changed;
      }),
    onFinish: (grant: DeviceControlGrant, finish: Effect.Effect<void, DeviceControlError>) =>
      Effect.suspend(() => {
        const error = check(grant);
        if (error) return Effect.fail(error);
        get(grant).finish.add(finish);
        return Effect.void;
      }),
    disconnect: (sessionId: string, viewerId?: string) =>
      invalidateWhere(
        (state) =>
          state.owner?.kind === "viewer" &&
          state.owner.sessionId === sessionId &&
          (viewerId === undefined || state.owner.viewerId === viewerId),
      ),
    invalidateHost: (hostId: string) => invalidateWhere((state) => state.hostId === hostId),
    invalidateAll: invalidateWhere(() => true),
    stopRun: (threadId: string, runId: string) =>
      Effect.sync(() => {
        stopped.add(runKey(threadId, runId));
      }).pipe(
        Effect.andThen(
          invalidateWhere(
            (state) =>
              state.owner?.kind === "agent" &&
              state.owner.threadId === threadId &&
              state.owner.runId === runId,
          ),
        ),
        Effect.ignore,
      ),
    /** Only after host.stop/restart has joined all old helpers may uncertainty be cleared. */
    hostStopped: (hostId: string, tools: ReadonlyArray<"hub" | "agent"> = ["hub", "agent"]) =>
      Effect.gen(function* () {
        for (const entry of entries.values())
          if (entry.state.hostId === hostId) {
            for (const tool of tools) entry.uncertain.delete(tool);
            if (tools.includes("hub")) entry.finish.clear();
          }
        yield* invalidateWhere((state) => state.hostId === hostId);
      }),
  };
});
export type DeviceControl = Effect.Success<ReturnType<typeof make>>;
