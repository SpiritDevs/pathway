import {
  ThreadId,
  type ComputerSurfaceInput,
  type ComputerSurfaceState,
} from "@spiritdevs/contracts";
import { Deferred, Effect, PubSub, Stream } from "effect";
import { ComputerBackendError, type ComputerOperationError } from "./computerErrors.ts";
import {
  DesktopOperationQueue,
  desktopSignal,
  makeDesktopAbort,
  type DesktopAbort,
} from "./DesktopOperationQueue.ts";

const denied = () =>
  new ComputerBackendError({ message: "This connection does not hold computer control." });
const PAUSED = Symbol("surface-paused");

/** Transient human ownership. Thread consent remains in ComputerControlState. */
export class ComputerSurfaceControl {
  private holder:
    | { clientId: string; released: Deferred.Deferred<void>; abort: DesktopAbort; closing: boolean }
    | undefined;
  private readonly turns = new Map<string, string>();
  private readonly actions: string[] = [];
  private omitted = 0;
  private revision = 0;

  private readonly computerId: string;
  private readonly queue: DesktopOperationQueue;
  private readonly updates: PubSub.PubSub<ComputerSurfaceState>;
  private readonly capabilities: () => ComputerSurfaceState["capabilities"];
  private readonly stopInput: () => Effect.Effect<void, ComputerOperationError>;

  constructor(
    computerId: string,
    queue: DesktopOperationQueue,
    updates: PubSub.PubSub<ComputerSurfaceState>,
    capabilities: () => ComputerSurfaceState["capabilities"],
    stopInput: () => Effect.Effect<void, ComputerOperationError>,
  ) {
    this.computerId = computerId;
    this.queue = queue;
    this.updates = updates;
    this.capabilities = capabilities;
    this.stopInput = stopInput;
  }

  get snapshot(): ComputerSurfaceState {
    const activeTurns = [...this.turns].map(([threadId, runId]) => ({
      threadId: ThreadId.make(threadId),
      runId,
    }));
    return {
      computerId: this.computerId,
      revision: this.revision,
      controller: this.holder
        ? { kind: "client", clientId: this.holder.clientId }
        : activeTurns[0]
          ? { kind: "agent", threadId: activeTurns[0].threadId }
          : { kind: "idle" },
      activeTurns,
      capabilities: this.capabilities(),
    };
  }

  get changes() {
    return Stream.unwrap(
      Effect.gen({ self: this }, function* () {
        const subscription = yield* PubSub.subscribe(this.updates);
        return Stream.concat(Stream.succeed(this.snapshot), Stream.fromSubscription(subscription));
      }),
    );
  }

  publish(): void {
    this.revision++;
    PubSub.publishUnsafe(this.updates, this.snapshot);
  }

  startTurn(threadId: string, runId: string): void {
    if (this.turns.get(threadId) === runId) return;
    this.turns.set(threadId, runId);
    this.publish();
  }

  endTurn(threadId: string, runId: string): void {
    if (this.turns.get(threadId) !== runId) return;
    this.turns.delete(threadId);
    this.publish();
  }

  /** Wait outside the desktop queue, then recheck inside it. A takeover never deadlocks queued agents. */
  withAgentControl<A, E>(
    enqueue: (
      action: Effect.Effect<A | typeof PAUSED, E>,
    ) => Effect.Effect<A | typeof PAUSED, E | ComputerOperationError>,
    action: Effect.Effect<A, E>,
  ) {
    return Effect.gen({ self: this }, function* () {
      while (true) {
        yield* this.waitForControl();
        const result = yield* enqueue(
          Effect.suspend<A | typeof PAUSED, E, never>(() =>
            this.holder ? Effect.succeed(PAUSED) : action,
          ),
        );
        if (result !== PAUSED) return result as A;
      }
    });
  }

  waitForControl(): Effect.Effect<void> {
    return Effect.suspend(() =>
      this.holder
        ? Deferred.await(this.holder.released).pipe(Effect.andThen(() => this.waitForControl()))
        : Effect.void,
    );
  }

  take(clientId: string) {
    return Effect.gen({ self: this }, function* () {
      if (this.holder) {
        if (this.holder.clientId !== clientId || this.holder.closing) return yield* denied();
        // A second take must wait for the same queue drain as the first.
        yield* this.queue.run(Effect.void);
        return;
      }
      const holder = {
        clientId,
        released: Deferred.makeUnsafe<void>(),
        abort: makeDesktopAbort(),
        closing: false,
      };
      this.holder = holder;
      this.actions.length = 0;
      this.omitted = 0;
      this.publish();
      yield* this.queue
        .run(Effect.void)
        .pipe(Effect.onError(() => Effect.sync(() => this.clear(holder))));
    });
  }

  assertUnclaimed() {
    return Effect.suspend(() => (this.holder ? Effect.fail(denied()) : Effect.void));
  }

  assertHolder(clientId: string, allowClosing = false) {
    return Effect.suspend(() =>
      this.holder?.clientId === clientId && (allowClosing || !this.holder.closing)
        ? Effect.void
        : Effect.fail(denied()),
    );
  }

  input<A, E>(clientId: string, event: ComputerSurfaceInput, action: Effect.Effect<A, E>) {
    return Effect.gen({ self: this }, function* () {
      yield* this.assertHolder(clientId);
      const holder = this.holder!;
      return yield* this.queue.run(
        Effect.gen({ self: this }, function* () {
          if (this.holder !== holder) return yield* denied();
          const result = yield* action;
          this.record(event);
          return result;
        }),
        desktopSignal(holder.abort),
      );
    });
  }

  /** Capture and persist under the same queue barrier as the release. Failure retains ownership. */
  handBack<A, E, R>(clientId: string, capture: (summary: string) => Effect.Effect<A, E, R>) {
    return Effect.gen({ self: this }, function* () {
      yield* this.assertHolder(clientId);
      const holder = this.holder!;
      holder.closing = true;
      return yield* this.queue
        .run(
          Effect.gen({ self: this }, function* () {
            if (this.holder !== holder) return yield* denied();
            const result = yield* capture(this.summary);
            yield* this.stopInput();
            this.clear(holder);
            return result;
          }),
          desktopSignal(holder.abort),
        )
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              holder.closing = false;
            }),
          ),
        );
    });
  }

  release(clientId: string) {
    return this.handBack(clientId, () => Effect.void);
  }

  disconnect(clientId: string) {
    return Effect.suspend(() =>
      this.holder?.clientId === clientId ? this.interrupt() : Effect.void,
    );
  }

  /** Escape invalidates all accepted user input before stopping native held input. */
  interrupt() {
    return Effect.gen({ self: this }, function* () {
      const holder = this.holder;
      if (!holder) return;
      holder.closing = true;
      Deferred.doneUnsafe(
        holder.abort,
        Effect.fail(
          new ComputerBackendError({
            message: "Computer input was stopped.",
            controlRevoked: true,
          }),
        ),
      );
      yield* this.stopInput().pipe(Effect.ensuring(Effect.sync(() => this.clear(holder))));
    });
  }

  private clear(holder: NonNullable<ComputerSurfaceControl["holder"]>) {
    if (this.holder !== holder) return;
    this.holder = undefined;
    this.actions.length = 0;
    this.omitted = 0;
    Deferred.doneUnsafe(holder.released, Effect.void);
    this.publish();
  }

  private get summary() {
    return [
      "The user controlled the computer.",
      ...(this.omitted ? [`${this.omitted} earlier actions omitted.`] : []),
      ...this.actions,
    ].join("\n");
  }

  private record(event: ComputerSurfaceInput) {
    // Do not put passwords or other typed content in the action log.
    const description =
      event.type === "type"
        ? `Typed ${event.text.length} characters.`
        : event.type === "key"
          ? "Pressed a key or shortcut."
          : event.type === "wheel"
            ? `Scrolled at (${event.x}, ${event.y}) by (${event.deltaX}, ${event.deltaY}).`
            : `${event.type} at (${event.x}, ${event.y}).`;
    if (event.type === "pointer.move" && this.actions.at(-1)?.startsWith("pointer.move"))
      this.actions.pop();
    this.actions.push(description);
    if (this.actions.length > 32) {
      this.actions.shift();
      this.omitted++;
    }
  }
}
