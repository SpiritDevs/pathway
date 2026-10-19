// @effect-diagnostics nodeBuiltinImport:off - a Unix socket is the one event a dead process reliably sends.
/**
 * Observes processes a test spawned without polling for them.
 *
 * Each process under test connects to the witness socket and writes its pid.
 * The kernel closes that connection when the process dies, however it dies, so
 * "the tree is gone" becomes an awaited event rather than a `kill -0` loop.
 */
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

export interface ProcessWitness {
  readonly socketPath: string;
  /** JavaScript a node process runs to report in; it keeps the process alive. */
  readonly reportScript: string;
  /** The pids of the first `count` processes to report in, in arrival order. */
  readonly reported: (count: number) => Effect.Effect<readonly number[]>;
  /** Succeeds once every process that has reported in has exited. */
  readonly allGone: Effect.Effect<void>;
}

export const makeProcessWitness = (
  directory: string,
): Effect.Effect<ProcessWitness, never, Scope.Scope> =>
  Effect.gen(function* () {
    const socketPath = NodePath.join(directory, "witness.sock");
    const pids: number[] = [];
    const gone: Deferred.Deferred<void>[] = [];
    const waiters: { count: number; deferred: Deferred.Deferred<readonly number[]> }[] = [];
    const settleWaiters = () => {
      for (const waiter of waiters) {
        if (pids.length >= waiter.count) {
          Deferred.doneUnsafe(waiter.deferred, Exit.succeed(pids.slice(0, waiter.count)));
        }
      }
    };
    const connections = new Set<NodeNet.Socket>();
    const server = NodeNet.createServer((connection) => {
      connections.add(connection);
      const closed = Deferred.makeUnsafe<void>();
      gone.push(closed);
      connection.on("error", () => undefined);
      connection.once("close", () => Deferred.doneUnsafe(closed, Exit.void));
      let buffered = "";
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        const newline = buffered.indexOf("\n");
        if (newline === -1) return;
        connection.off("data", onData);
        pids.push(Number(buffered.slice(0, newline)));
        settleWaiters();
      };
      connection.on("data", onData);
    });
    yield* Effect.callback<void>((resume) => {
      server.listen(socketPath, () => resume(Effect.void));
    });
    yield* Effect.addFinalizer(() =>
      Effect.callback<void>((resume) => {
        // A process a failed test left behind must not hold the server open.
        for (const connection of connections) connection.destroy();
        server.close(() => resume(Effect.void));
      }),
    );
    return {
      socketPath,
      // @effect-diagnostics-next-line preferSchemaOverJson:off - quotes a path into generated source.
      reportScript: `const s=require('node:net').connect(${JSON.stringify(socketPath)});s.on('error',()=>{});s.write(process.pid+'\\n');setInterval(()=>{},1000);`,
      reported: (count) =>
        Effect.suspend(() => {
          const deferred = Deferred.makeUnsafe<readonly number[]>();
          waiters.push({ count, deferred });
          settleWaiters();
          return Deferred.await(deferred);
        }),
      allGone: Effect.suspend(() =>
        Effect.forEach(gone, (closed) => Deferred.await(closed), { discard: true }),
      ),
    } satisfies ProcessWitness;
  });
