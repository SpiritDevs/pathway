/**
 * Which threads each client connection is looking at, so thread-scoped
 * computer events only go to the connections that show that thread.
 *
 * @module computer/computerEventInterests
 */
import type { ComputerEvent } from "@spiritdevs/contracts";
import * as Stream from "effect/Stream";

export const MAX_COMPUTER_THREAD_INTERESTS_PER_CONNECTION = 64;

interface ConnectionInterests {
  // A connection with more views falls back to broadcast instead of losing
  // updates for a view that remains open. Null also releases the remembered ids.
  threads: Set<string> | null;
}

/**
 * Interests belong to the socket, so stream retries preserve them.
 *
 * `onConnectionClose(key, cleanup)` registers `cleanup` to run when that
 * connection closes, and returns false when the connection is already gone.
 */
export class ComputerEventInterests {
  readonly #connections = new Map<string, ConnectionInterests>();
  readonly #onConnectionClose: (key: string, cleanup: () => void) => boolean;

  constructor(onConnectionClose: (key: string, cleanup: () => void) => boolean) {
    this.#onConnectionClose = onConnectionClose;
  }

  #connect(connectionKey: string | undefined): void {
    if (connectionKey === undefined || this.#connections.has(connectionKey)) return;
    if (this.#onConnectionClose(connectionKey, () => this.#connections.delete(connectionKey))) {
      this.#connections.set(connectionKey, { threads: new Set() });
    }
  }

  /** `events`, narrowed to what this connection watches. Connects when the stream starts. */
  subscribe(
    connectionKey: string | undefined,
    events: Stream.Stream<ComputerEvent>,
  ): Stream.Stream<ComputerEvent> {
    return Stream.suspend(() => {
      this.#connect(connectionKey);
      return events.pipe(Stream.filter((event) => this.accepts(connectionKey, event)));
    });
  }

  watch(connectionKey: string | undefined, threadId: string): void {
    this.#connect(connectionKey);
    const interests =
      connectionKey === undefined ? undefined : this.#connections.get(connectionKey);
    if (!interests?.threads) return;
    interests.threads.add(threadId);
    if (interests.threads.size > MAX_COMPUTER_THREAD_INTERESTS_PER_CONNECTION) {
      interests.threads = null;
    }
  }

  accepts(connectionKey: string | undefined, event: ComputerEvent): boolean {
    // In-process callers without the socket registry keep the prior behavior.
    if (connectionKey === undefined) return true;
    const interests = this.#connections.get(connectionKey);
    if (!interests) return false;
    const threadId =
      event.type === "computer.thread-state"
        ? event.state.threadId
        : event.type === "computer.action"
          ? event.threadId
          : undefined;
    return threadId === undefined || interests.threads === null || interests.threads.has(threadId);
  }
}
