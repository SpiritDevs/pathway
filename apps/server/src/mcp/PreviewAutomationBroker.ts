import {
  PREVIEW_AUTOMATION_V1_OPERATIONS,
  PreviewAutomationClientDisconnectedError,
  PreviewAutomationExecutionError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationMalformedResponseError,
  PreviewAutomationNoAvailableHostError,
  PreviewAutomationRemoteUnavailableError,
  PreviewAutomationRequestQueueClosedError,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationTabNotFoundError,
  PreviewAutomationTakeoverActiveError,
  PreviewAutomationTargetNotEditableError,
  PreviewAutomationTimeoutError,
  PreviewAutomationUnsupportedClientError,
  PreviewTabId,
  type EnvironmentId,
  type PreviewAutomationError,
  type PreviewAutomationOperation,
  type PreviewAutomationHost,
  type PreviewAutomationHostFocus,
  type PreviewAutomationResponse,
  type PreviewAutomationStreamEvent,
  type ThreadId,
} from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import {
  PreviewAutomationActivitySink,
  PreviewAutomationTakeoverFence,
  PreviewTakeoverFenceError,
  type PreviewActivityRecord,
  type PreviewTakeoverLease,
} from "./PreviewAutomationTakeover.ts";

export interface PreviewAutomationInvokeInput {
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly operation: PreviewAutomationOperation;
  readonly input: unknown;
  readonly tabId?: PreviewTabId;
  readonly timeoutMs?: number;
}

export class PreviewAutomationBroker extends Context.Service<
  PreviewAutomationBroker,
  {
    readonly connect: (
      host: PreviewAutomationHost,
    ) => Effect.Effect<Stream.Stream<PreviewAutomationStreamEvent>>;
    readonly focusHost: (host: PreviewAutomationHostFocus) => Effect.Effect<void>;
    readonly respond: (
      response: PreviewAutomationResponse,
    ) => Effect.Effect<void, PreviewAutomationError>;
    readonly invoke: <A = unknown>(
      request: PreviewAutomationInvokeInput,
    ) => Effect.Effect<A, PreviewAutomationError>;
  }
>()("@spiritdevs/pathway/mcp/PreviewAutomationBroker") {}

interface ClientConnection {
  readonly clientId: string;
  readonly connectionId: string;
  readonly environmentId: PreviewAutomationHost["environmentId"];
  readonly supportedOperations: ReadonlySet<PreviewAutomationOperation>;
  readonly focused: boolean;
  readonly focusOrder: number;
  readonly queue: Queue.Queue<PreviewAutomationStreamEvent>;
}

interface PendingRequest {
  readonly queue: ClientConnection["queue"];
  readonly deferred: Deferred.Deferred<unknown, PreviewAutomationError>;
  /**
   * Completed once the owning `invoke` has stopped touching broker state, which
   * a takeover drain waits on. Distinct from {@link deferred}: an invoke that
   * times out or is interrupted never resolves its response deferred, yet is
   * just as finished from the fence's point of view.
   */
  readonly settled: Deferred.Deferred<void>;
  readonly context: PreviewAutomationRequestErrorContext;
}

/**
 * A lease pinning one provider session to one desktop runtime. It lives exactly
 * as long as the connection it names: `connectionId`/`queue` identity is what
 * makes a lease valid, so a disconnected or replaced host is dropped on the next
 * lookup. The lease deliberately has no clock of its own — it used to inherit
 * the MCP credential's expiry, which coupled host stickiness to an unrelated
 * auth deadline and could migrate a live session to another runtime mid-flow.
 */
interface HostAssignment {
  readonly clientId: ClientConnection["clientId"];
  readonly connectionId: ClientConnection["connectionId"];
  readonly queue: ClientConnection["queue"];
  /** Thread that last routed through this assignment; how a takeover finds the host to pin. */
  readonly threadId: ThreadId;
  /** Request sequence of the routing that wrote this assignment, so "latest for a thread" is total. */
  readonly sequence: number;
  readonly tabId?: PreviewTabId;
  readonly tabSequence?: number;
}

interface PreviewAutomationRequestErrorContext {
  readonly operation: PreviewAutomationOperation;
  readonly environmentId: McpInvocationContext.McpInvocationScope["environmentId"];
  readonly threadId: McpInvocationContext.McpInvocationScope["threadId"];
  readonly providerSessionId: string;
  readonly providerInstanceId: McpInvocationContext.McpInvocationScope["providerInstanceId"];
  readonly clientId: string;
  readonly connectionId: ClientConnection["connectionId"];
  readonly requestId: string;
  readonly tabId?: PreviewTabId;
  readonly timeoutMs: number;
  readonly selectorKind?: "locator" | "selector";
  readonly selectorLength?: number;
}

/**
 * A human holding one thread's browser. `draining` still blocks every new
 * request: exclusivity starts the instant a takeover is requested, and only the
 * wait for in-flight requests to finish separates it from `exclusive`.
 */
interface TakeoverFence {
  readonly takeoverId: string;
  readonly state: "draining" | "exclusive";
  readonly hostClientId: string | null;
  readonly hostConnectionId: string | null;
  readonly tabId: PreviewTabId | null;
}

/** Outcome of the one transaction that routes an invoke: fenced, hostless, or on its way. */
type InvokeRoute =
  | { readonly kind: "blocked"; readonly takeoverId: string }
  | {
      readonly kind: "routed";
      readonly connection: ClientConnection;
      readonly requestId: string;
      readonly requestContext: PreviewAutomationRequestErrorContext;
      readonly requestSequence: number;
      readonly activity: PreviewActivityRecord;
    }
  | undefined;

interface BrokerState {
  readonly clients: ReadonlyMap<string, ClientConnection>;
  readonly assignments: ReadonlyMap<string, HostAssignment>;
  readonly pending: ReadonlyMap<string, PendingRequest>;
  readonly fences: ReadonlyMap<string, TakeoverFence>;
  readonly requestSequence: number;
  readonly focusSequence: number;
}

const removeConnectionFromState = (
  current: BrokerState,
  clientId: string,
  queue: ClientConnection["queue"],
): { readonly state: BrokerState; readonly disconnected: ReadonlyArray<PendingRequest> } => {
  const clients = new Map(current.clients);
  const assignments = new Map(current.assignments);
  const pending = new Map(current.pending);
  const disconnected: PendingRequest[] = [];
  if (current.clients.get(clientId)?.queue === queue) clients.delete(clientId);
  for (const [assignmentKey, assignment] of assignments) {
    if (assignment.queue === queue) assignments.delete(assignmentKey);
  }
  for (const [requestId, entry] of pending) {
    if (entry.queue !== queue) continue;
    pending.delete(requestId);
    disconnected.push(entry);
  }
  return {
    state: { ...current, clients, assignments, pending },
    disconnected,
  };
};

const selectorDiagnosticsFromInput = (
  input: unknown,
): Pick<PreviewAutomationRequestErrorContext, "selectorKind" | "selectorLength"> => {
  if (typeof input !== "object" || input === null) return {};
  if ("locator" in input && typeof input.locator === "string") {
    return { selectorKind: "locator", selectorLength: input.locator.length };
  }
  if ("selector" in input && typeof input.selector === "string") {
    return { selectorKind: "selector", selectorLength: input.selector.length };
  }
  return {};
};

const hostAssignmentKey = (scope: McpInvocationContext.McpInvocationScope): string =>
  `${scope.environmentId}\u0000${scope.providerSessionId}`;

/** Takeovers and preview activity are keyed per thread, not per provider session. */
const threadKey = (environmentId: EnvironmentId, threadId: ThreadId): string =>
  `${environmentId}\u0000${threadId}`;

const isConnectionLive = (current: BrokerState, assignment: HostAssignment): boolean => {
  const connection = current.clients.get(assignment.clientId);
  return (
    connection?.connectionId === assignment.connectionId && connection.queue === assignment.queue
  );
};

const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

/**
 * The broker deliberately does not suppress repeat records. It cannot see the
 * run driving an invoke (the orchestrator resolves that at dispatch time), and
 * a provider session, host, and pinned tab all survive across runs on a thread,
 * so any broker-side "nothing changed" check would silently drop the marker for
 * every run after the first. Deduping belongs to the decider, which knows the
 * run id and rejects true no-ops before writing an event.
 */
const activityRecord = (
  scope: McpInvocationContext.McpInvocationScope,
  hostClientId: string,
  tabId: PreviewTabId | null,
): PreviewActivityRecord => ({
  environmentId: scope.environmentId,
  threadId: scope.threadId,
  providerSessionId: scope.providerSessionId,
  tabId,
  hostClientId,
});

const isPreviewTabId = Schema.is(PreviewTabId);

const readResultTabId = (result: unknown): PreviewTabId | null | undefined => {
  if (typeof result !== "object" || result === null || !("tabId" in result)) return undefined;
  const tabId = result.tabId;
  return tabId === null || isPreviewTabId(tabId) ? tabId : undefined;
};

const supportsOperation = (
  connection: ClientConnection,
  operation: PreviewAutomationOperation,
): boolean => connection.supportedOperations.has(operation);

/**
 * `status` is a capability probe used to discover whether Preview is attached;
 * it does not mean the agent is driving the browser. Recording it as activity
 * would offer a takeover for unrelated Pathway MCP work after a harmless probe.
 */
const recordsPreviewActivity = (operation: PreviewAutomationOperation): boolean =>
  operation !== "status";

type RemoteDetailKind = "null" | "array" | "object" | "string" | "number" | "boolean";

function remoteDetailKind(detail: unknown): RemoteDetailKind {
  if (detail === null) return "null";
  if (Array.isArray(detail)) return "array";
  switch (typeof detail) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}

const classifyResponseError = (
  context: PreviewAutomationRequestErrorContext,
  error: NonNullable<PreviewAutomationResponse["error"]>,
): PreviewAutomationError => {
  const remoteDiagnostics = {
    remoteTag: error._tag,
    remoteMessageLength: error.message.length,
    ...(error.detail === undefined ? {} : { remoteDetailKind: remoteDetailKind(error.detail) }),
    cause: error,
  };
  switch (error._tag) {
    case "PreviewAutomationNoAvailableHostError":
      return new PreviewAutomationNoAvailableHostError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationUnsupportedClientError":
      return new PreviewAutomationUnsupportedClientError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationTabNotFoundError":
      return new PreviewAutomationTabNotFoundError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationTimeoutError":
      return new PreviewAutomationTimeoutError({
        ...context,
        ...remoteDiagnostics,
      });
    case "PreviewAutomationInvalidSelectorError": {
      return new PreviewAutomationInvalidSelectorError({
        ...context,
        ...remoteDiagnostics,
      });
    }
    case "PreviewAutomationTargetNotEditableError": {
      const detail =
        typeof error.detail === "object" && error.detail !== null ? error.detail : undefined;
      const remoteSelectorKind =
        detail &&
        "selectorKind" in detail &&
        (detail.selectorKind === "focused-element" ||
          detail.selectorKind === "locator" ||
          detail.selectorKind === "selector")
          ? detail.selectorKind
          : undefined;
      const remoteSelectorLength =
        detail &&
        "selectorLength" in detail &&
        typeof detail.selectorLength === "number" &&
        Number.isInteger(detail.selectorLength) &&
        detail.selectorLength >= 0
          ? detail.selectorLength
          : undefined;
      return new PreviewAutomationTargetNotEditableError({
        ...context,
        ...remoteDiagnostics,
        ...(remoteSelectorKind === undefined && context.selectorKind === undefined
          ? {}
          : { selectorKind: remoteSelectorKind ?? context.selectorKind }),
        ...(remoteSelectorLength === undefined && context.selectorLength === undefined
          ? {}
          : { selectorLength: remoteSelectorLength ?? context.selectorLength }),
      });
    }
    case "PreviewAutomationResultTooLargeError": {
      const detail =
        typeof error.detail === "object" && error.detail !== null ? error.detail : undefined;
      const maximumBytes =
        detail &&
        "maximumBytes" in detail &&
        typeof detail.maximumBytes === "number" &&
        Number.isInteger(detail.maximumBytes) &&
        detail.maximumBytes > 0
          ? detail.maximumBytes
          : undefined;
      return new PreviewAutomationResultTooLargeError({
        ...context,
        ...remoteDiagnostics,
        ...(maximumBytes === undefined ? {} : { maximumBytes }),
      });
    }
    case "PreviewAutomationUnavailableError":
      return new PreviewAutomationRemoteUnavailableError({
        ...context,
        ...remoteDiagnostics,
      });
    default:
      return new PreviewAutomationExecutionError({
        ...context,
        ...remoteDiagnostics,
      });
  }
};

export const makeServices = Effect.gen(function* PreviewAutomationBrokerMake() {
  const crypto = yield* Crypto.Crypto;
  const activitySink = yield* PreviewAutomationActivitySink;
  const state = yield* SynchronizedRef.make<BrokerState>({
    clients: new Map(),
    assignments: new Map(),
    pending: new Map(),
    fences: new Map(),
    requestSequence: 0,
    focusSequence: 0,
  });

  /**
   * Publishes a host/tab observation. Detached and log-only: the marker exists
   * so the client can offer a takeover, and losing one must never fail the
   * browser action that produced it.
   */
  const publishActivity = (record: PreviewActivityRecord) =>
    activitySink
      .record(record)
      .pipe(
        Effect.ignoreCause({ log: true }),
        Effect.forkDetach({ startImmediately: true }),
        Effect.asVoid,
      );

  const closeConnection = Effect.fn("PreviewAutomationBroker.closeConnection")(function* (
    queue: ClientConnection["queue"],
    disconnected: ReadonlyArray<PendingRequest>,
  ) {
    yield* Effect.forEach(
      disconnected,
      ({ deferred, context }) =>
        Deferred.fail(deferred, new PreviewAutomationClientDisconnectedError(context)),
      { discard: true },
    );
    yield* Queue.shutdown(queue);
  });

  const disconnect = Effect.fn("PreviewAutomationBroker.disconnect")(function* (
    clientId: string,
    queue: ClientConnection["queue"],
  ) {
    const disconnected = yield* SynchronizedRef.modify(state, (current) => {
      const removed = removeConnectionFromState(current, clientId, queue);
      return [removed.disconnected, removed.state] as const;
    });
    yield* closeConnection(queue, disconnected);
  });

  const acquireConnection = Effect.fn("PreviewAutomationBroker.acquireConnection")(function* (
    host: PreviewAutomationHost,
  ) {
    const clientId = host.clientId;
    const queue = yield* Queue.unbounded<PreviewAutomationStreamEvent>();
    const connectionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    yield* Queue.offer(queue, { type: "connected", connectionId });
    const connection: ClientConnection = {
      clientId,
      connectionId,
      environmentId: host.environmentId,
      supportedOperations: new Set(host.supportedOperations ?? PREVIEW_AUTOMATION_V1_OPERATIONS),
      focused: false,
      focusOrder: 0,
      queue,
    };
    const registration = yield* SynchronizedRef.modify(state, (current) => {
      const previousConnection = current.clients.get(clientId);
      const removed = previousConnection
        ? removeConnectionFromState(current, clientId, previousConnection.queue)
        : { state: current, disconnected: [] };
      const clients = new Map(removed.state.clients);
      const focusSequence = removed.state.focusSequence + 1;
      const registeredConnection = { ...connection, focusOrder: focusSequence };
      clients.set(clientId, registeredConnection);
      return [
        {
          previousConnection,
          disconnected: removed.disconnected,
          registeredConnection,
        },
        { ...removed.state, clients, focusSequence },
      ] as const;
    });
    if (registration.previousConnection) {
      yield* closeConnection(registration.previousConnection.queue, registration.disconnected);
    }
    return registration.registeredConnection;
  });

  const connect: PreviewAutomationBroker["Service"]["connect"] = Effect.fn(
    "PreviewAutomationBroker.connect",
  )((host) =>
    Effect.succeed(
      Stream.unwrap(
        Effect.acquireRelease(acquireConnection(host), (connection) =>
          disconnect(connection.clientId, connection.queue),
        ).pipe(Effect.map((connection) => Stream.fromQueue(connection.queue))),
      ),
    ),
  );

  const focusHost: PreviewAutomationBroker["Service"]["focusHost"] = Effect.fn(
    "PreviewAutomationBroker.focusHost",
  )(function* (host) {
    yield* SynchronizedRef.update(state, (current) => {
      const currentHost = current.clients.get(host.clientId);
      if (
        !currentHost ||
        currentHost.environmentId !== host.environmentId ||
        currentHost.connectionId !== host.connectionId
      ) {
        return current;
      }
      const clients = new Map(current.clients);
      const focusSequence = host.focused ? current.focusSequence + 1 : current.focusSequence;
      clients.set(host.clientId, {
        ...currentHost,
        focused: host.focused,
        focusOrder: host.focused ? focusSequence : currentHost.focusOrder,
      });
      return { ...current, clients, focusSequence };
    });
  });

  const respond: PreviewAutomationBroker["Service"]["respond"] = Effect.fn(
    "PreviewAutomationBroker.respond",
  )(function* (response) {
    const pending = yield* SynchronizedRef.modify(state, (current) => {
      const entry = current.pending.get(response.requestId);
      if (
        !entry ||
        entry.context.clientId !== response.clientId ||
        entry.context.connectionId !== response.connectionId
      ) {
        return [undefined, current] as const;
      }
      const next = new Map(current.pending);
      next.delete(response.requestId);
      return [entry, { ...current, pending: next }] as const;
    });
    if (!pending) return;
    if (response.ok) {
      yield* Deferred.succeed(pending.deferred, response.result);
    } else {
      yield* Deferred.fail(
        pending.deferred,
        response.error
          ? classifyResponseError(pending.context, response.error)
          : new PreviewAutomationMalformedResponseError(pending.context),
      );
    }
  });

  const invoke = Effect.fn("PreviewAutomationBroker.invoke")(function* <A = unknown>(
    input: Parameters<PreviewAutomationBroker["Service"]["invoke"]>[0],
  ): Effect.fn.Return<A, PreviewAutomationError> {
    const timeoutMs = input.timeoutMs ?? 15_000;
    const deferred = yield* Deferred.make<unknown, PreviewAutomationError>();
    const settled = yield* Deferred.make<void>();
    const route = yield* SynchronizedRef.modify(
      state,
      (current): readonly [InvokeRoute, BrokerState] => {
        // Both preview tool handlers and issues_comment_evidence land here, so
        // the takeover fence sits in routing rather than in any one caller. A
        // fenced thread never fails over to another host or queues for later: the
        // agent is told a human holds the browser.
        const fence = current.fences.get(
          threadKey(input.scope.environmentId, input.scope.threadId),
        );
        if (fence) {
          return [{ kind: "blocked", takeoverId: fence.takeoverId } as const, current] as const;
        }
        const assignments = new Map(
          Array.from(current.assignments).filter(([, assignment]) => {
            const connection = current.clients.get(assignment.clientId);
            return (
              connection?.connectionId === assignment.connectionId &&
              connection.queue === assignment.queue
            );
          }),
        );
        const assignmentKey = hostAssignmentKey(input.scope);
        const assigned = assignments.get(assignmentKey);
        const assignedConnection = assigned ? current.clients.get(assigned.clientId) : undefined;
        const hasLiveAssignment = assignedConnection?.environmentId === input.scope.environmentId;
        // Keep one provider session on one physical desktop runtime so a
        // multi-step browser interaction cannot jump between independent
        // Electron cookie/DOM state. A live assignment that predates an
        // operation is not silently moved to a newer client: the caller gets a
        // capability failure and can deliberately start a fresh provider
        // session. A dead lease is pruned above and may fail over.
        const connection =
          hasLiveAssignment && supportsOperation(assignedConnection, input.operation)
            ? assignedConnection
            : hasLiveAssignment
              ? undefined
              : Array.from(current.clients.values())
                  .filter(
                    (host) =>
                      host.environmentId === input.scope.environmentId &&
                      supportsOperation(host, input.operation),
                  )
                  .sort(
                    (left, right) =>
                      right.supportedOperations.size - left.supportedOperations.size ||
                      Number(right.focused) - Number(left.focused) ||
                      right.focusOrder - left.focusOrder,
                  )[0];
        if (!connection) {
          if (!hasLiveAssignment) assignments.delete(assignmentKey);
          return [undefined, { ...current, assignments }] as const;
        }
        const canReuseAssignedTab =
          assigned !== undefined &&
          assigned.connectionId === connection.connectionId &&
          assigned.queue === connection.queue;
        const requestSequence = current.requestSequence;
        assignments.set(assignmentKey, {
          clientId: connection.clientId,
          connectionId: connection.connectionId,
          queue: connection.queue,
          threadId: input.scope.threadId,
          sequence: requestSequence,
          ...(canReuseAssignedTab && assigned.tabId !== undefined ? { tabId: assigned.tabId } : {}),
          ...(canReuseAssignedTab && assigned.tabSequence !== undefined
            ? { tabSequence: assigned.tabSequence }
            : {}),
        });

        const requestId = `preview-${requestSequence}`;
        const tabId = input.tabId ?? (canReuseAssignedTab ? assigned.tabId : undefined);
        const selectorDiagnostics = selectorDiagnosticsFromInput(input.input);
        const context: PreviewAutomationRequestErrorContext = {
          operation: input.operation,
          environmentId: input.scope.environmentId,
          threadId: input.scope.threadId,
          providerSessionId: input.scope.providerSessionId,
          providerInstanceId: input.scope.providerInstanceId,
          clientId: connection.clientId,
          connectionId: connection.connectionId,
          requestId,
          ...(tabId === undefined ? {} : { tabId }),
          timeoutMs,
          ...selectorDiagnostics,
        };
        const pending = new Map(current.pending);
        pending.set(requestId, { queue: connection.queue, deferred, settled, context });
        return [
          {
            kind: "routed",
            connection,
            requestId,
            requestContext: context,
            requestSequence,
            activity: activityRecord(input.scope, connection.clientId, tabId ?? null),
          } as const,
          {
            ...current,
            assignments,
            pending,
            requestSequence: requestSequence + 1,
          },
        ] as const;
      },
    );
    if (!route) {
      return yield* new PreviewAutomationNoAvailableHostError({
        operation: input.operation,
        environmentId: input.scope.environmentId,
        threadId: input.scope.threadId,
        providerSessionId: input.scope.providerSessionId,
        providerInstanceId: input.scope.providerInstanceId,
      });
    }
    if (route.kind === "blocked") {
      return yield* new PreviewAutomationTakeoverActiveError({
        operation: input.operation,
        environmentId: input.scope.environmentId,
        threadId: input.scope.threadId,
        providerSessionId: input.scope.providerSessionId,
        providerInstanceId: input.scope.providerInstanceId,
        ...(input.tabId === undefined ? {} : { tabId: input.tabId }),
        timeoutMs,
        takeoverId: route.takeoverId,
      });
    }
    const { connection, requestId, requestContext, requestSequence } = route;
    const removePending = SynchronizedRef.update(state, (next) => {
      if (!next.pending.has(requestId)) return next;
      const pending = new Map(next.pending);
      pending.delete(requestId);
      return { ...next, pending };
    });
    const awaitResponse = Effect.fn("PreviewAutomationBroker.awaitResponse")(function* () {
      const offered = yield* Queue.offer(connection.queue, {
        type: "request",
        connectionId: connection.connectionId,
        request: {
          requestId,
          threadId: input.scope.threadId,
          tabId: requestContext.tabId,
          tabIdExplicit: input.tabId !== undefined,
          operation: input.operation,
          input: input.input,
          timeoutMs,
        },
      });
      if (!offered) {
        const completion = yield* Deferred.poll(deferred);
        if (Option.isSome(completion)) {
          return (yield* completion.value) as A;
        }
        return yield* new PreviewAutomationRequestQueueClosedError(requestContext);
      }
      const result = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(timeoutMs));
      return yield* Option.match(result, {
        onNone: () => Effect.fail(new PreviewAutomationTimeoutError(requestContext)),
        onSome: (value) => Effect.succeed(value as A),
      });
    });
    const shouldRecordActivity = recordsPreviewActivity(input.operation);
    if (shouldRecordActivity) yield* publishActivity(route.activity);
    // `settled` outlives the response deferred on purpose: a takeover drain
    // waits for the whole invoke, including the tab bookkeeping below, so the
    // lease it hands the user names the tab this request ended on.
    const completed = yield* Effect.gen(function* () {
      const result = yield* awaitResponse().pipe(Effect.ensuring(removePending));
      const responseTabId = readResultTabId(result);
      const resultTabId = responseTabId === undefined ? input.tabId : responseTabId;
      if (resultTabId === undefined) return { result, activity: undefined };
      const assignmentKey = hostAssignmentKey(input.scope);
      const activity = yield* SynchronizedRef.modify(state, (current) => {
        const assignment = current.assignments.get(assignmentKey);
        if (
          !assignment ||
          assignment.connectionId !== connection.connectionId ||
          assignment.queue !== connection.queue ||
          (assignment.tabSequence ?? -1) > requestSequence
        ) {
          return [undefined, current] as const;
        }
        const assignments = new Map(current.assignments);
        if (resultTabId === null) {
          const { tabId: _tabId, ...withoutTabId } = assignment;
          assignments.set(assignmentKey, { ...withoutTabId, tabSequence: requestSequence });
        } else {
          assignments.set(assignmentKey, {
            ...assignment,
            tabId: resultTabId,
            tabSequence: requestSequence,
          });
        }
        // Only a correction: the record published when this request was routed
        // named the tab we expected, and the response moved it.
        const record =
          !shouldRecordActivity || resultTabId === route.activity.tabId
            ? undefined
            : activityRecord(input.scope, connection.clientId, resultTabId);
        return [record, { ...current, assignments }] as const;
      });
      return { result, activity };
    }).pipe(Effect.ensuring(Deferred.succeed(settled, undefined)));
    if (completed.activity) yield* publishActivity(completed.activity);
    return completed.result;
  });

  /**
   * Arms the fence before anything else: from here on new automation for the
   * thread is rejected, and only in-flight requests are still allowed to land.
   * The fence survives every failure below — a half-established takeover leaves
   * the browser blocked rather than silently handing it back to the agent.
   */
  const acquire: PreviewAutomationTakeoverFence["Service"]["acquire"] = Effect.fn(
    "PreviewAutomationTakeoverFence.acquire",
  )(function* (input) {
    const key = threadKey(input.environmentId, input.threadId);
    const armed = yield* SynchronizedRef.modify(state, (current) => {
      let captured:
        | { readonly assignmentKey: string; readonly assignment: HostAssignment }
        | undefined;
      for (const [assignmentKey, assignment] of current.assignments) {
        if (assignment.threadId !== input.threadId) continue;
        if (!isConnectionLive(current, assignment)) continue;
        if (current.clients.get(assignment.clientId)?.environmentId !== input.environmentId) {
          continue;
        }
        if (captured && captured.assignment.sequence > assignment.sequence) continue;
        captured = { assignmentKey, assignment };
      }
      if (!captured) return [undefined, current] as const;
      const fences = new Map(current.fences);
      fences.set(key, {
        takeoverId: input.takeoverId,
        state: "draining",
        hostClientId: captured.assignment.clientId,
        hostConnectionId: captured.assignment.connectionId,
        tabId: captured.assignment.tabId ?? null,
      });
      const draining = Array.from(current.pending)
        .filter(
          ([, entry]) =>
            entry.context.threadId === input.threadId &&
            entry.context.environmentId === input.environmentId,
        )
        .map(([requestId, entry]) => ({ requestId, entry }));
      return [
        { captured, draining },
        { ...current, fences },
      ] as const;
    });
    if (!armed) {
      return yield* new PreviewTakeoverFenceError({
        reason: "no_live_host",
        environmentId: input.environmentId,
        threadId: input.threadId,
        takeoverId: input.takeoverId,
      });
    }
    yield* Effect.forEach(armed.draining, ({ entry }) => Deferred.await(entry.settled), {
      concurrency: "unbounded",
      discard: true,
    }).pipe(Effect.timeoutOption(input.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS));
    const drained = yield* SynchronizedRef.modify(state, (current) => {
      const pending = new Map(current.pending);
      const stragglers: PendingRequest[] = [];
      for (const { requestId, entry } of armed.draining) {
        if (pending.get(requestId) !== entry) continue;
        pending.delete(requestId);
        stragglers.push(entry);
      }
      const assignment = current.assignments.get(armed.captured.assignmentKey);
      const live =
        assignment !== undefined &&
        assignment.connectionId === armed.captured.assignment.connectionId &&
        isConnectionLive(current, assignment);
      const lease: PreviewTakeoverLease = {
        hostClientId: armed.captured.assignment.clientId,
        hostConnectionId: armed.captured.assignment.connectionId,
        tabId: (live ? assignment.tabId : armed.captured.assignment.tabId) ?? null,
      };
      const fences = new Map(current.fences);
      fences.set(key, {
        takeoverId: input.takeoverId,
        state: "exclusive",
        hostClientId: lease.hostClientId,
        hostConnectionId: lease.hostConnectionId,
        tabId: isPreviewTabId(lease.tabId) ? lease.tabId : null,
      });
      return [
        { stragglers, live, lease },
        { ...current, pending, fences },
      ] as const;
    });
    yield* Effect.forEach(
      drained.stragglers,
      ({ deferred, context }) =>
        Deferred.fail(
          deferred,
          new PreviewAutomationTakeoverActiveError({ ...context, takeoverId: input.takeoverId }),
        ),
      { discard: true },
    );
    if (!drained.live) {
      return yield* new PreviewTakeoverFenceError({
        reason: "host_disconnected",
        environmentId: input.environmentId,
        threadId: input.threadId,
        takeoverId: input.takeoverId,
      });
    }
    return drained.lease;
  });

  const release: PreviewAutomationTakeoverFence["Service"]["release"] = Effect.fn(
    "PreviewAutomationTakeoverFence.release",
  )(function* (input) {
    yield* SynchronizedRef.update(state, (current) => {
      const key = threadKey(input.environmentId, input.threadId);
      const fence = current.fences.get(key);
      // A stale release must not free a newer takeover's fence.
      if (!fence || fence.takeoverId !== input.takeoverId) return current;
      const fences = new Map(current.fences);
      fences.delete(key);
      return { ...current, fences };
    });
  });

  const rearm: PreviewAutomationTakeoverFence["Service"]["rearm"] = Effect.fn(
    "PreviewAutomationTakeoverFence.rearm",
  )(function* (input) {
    yield* SynchronizedRef.update(state, (current) => {
      const fences = new Map(current.fences);
      fences.set(threadKey(input.environmentId, input.threadId), {
        takeoverId: input.takeoverId,
        state: "exclusive",
        hostClientId: input.hostClientId,
        hostConnectionId: input.hostConnectionId,
        tabId: isPreviewTabId(input.tabId) ? input.tabId : null,
      });
      return { ...current, fences };
    });
  });

  return {
    broker: PreviewAutomationBroker.of({ connect, focusHost, respond, invoke }),
    fence: PreviewAutomationTakeoverFence.of({ acquire, release, rearm }),
  };
}).pipe(Effect.withSpan("PreviewAutomationBroker.make"));

export const make = makeServices.pipe(Effect.map(({ broker }) => broker));

/**
 * Provides the broker and the takeover fence together: the fence is only
 * meaningful sharing this broker instance's state, and Layer memoization means
 * every consumer of this layer sees the one broker.
 */
export const layer = Layer.effectContext(
  makeServices.pipe(
    Effect.map(({ broker, fence }) =>
      Context.make(PreviewAutomationBroker, broker).pipe(
        Context.add(PreviewAutomationTakeoverFence, fence),
      ),
    ),
  ),
);
