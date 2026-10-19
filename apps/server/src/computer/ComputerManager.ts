// @effect-diagnostics preferSchemaOverJson:off - refusal messages quote ids and titles as JSON strings.
/**
 * Thread state, targeting, action dispatch, and stream ownership for one
 * computer.
 *
 * A literal Effect port of Synara's `ComputerManager`. The class keeps its
 * shape — mutable bookkeeping behind methods — but every method that did IO
 * returns an `Effect`. Detached promises are fibers in the manager's scope,
 * `AbortController`s are `DesktopAbort` deferreds, timers are scoped fibers,
 * and listeners are a `PubSub` read through `events`.
 *
 * ```ts
 * const manager = yield* ComputerManager.make({ backend, stateDir });
 * yield* manager.click(threadId, target);
 * ```
 *
 * @module computer/ComputerManager
 */
import {
  COMPUTER_PROVISION_SUMMARY_MAX_LENGTH,
  COMPUTER_TEXT_MAX_LENGTH,
  type ComputerAccessibilityTreeResult,
  type ComputerActionResult,
  type ComputerApp,
  type ComputerAvailability,
  type ComputerBuildSignature,
  type ComputerCapabilities,
  type ComputerControlMode,
  type ComputerCursorPosition,
  type ComputerEvent,
  type ComputerGetAuditHistoryInput,
  type ComputerGetScreenSizeResult,
  type ComputerHealth,
  type ComputerId,
  type ComputerInputModifier,
  type ComputerLaunchAppResult,
  type ComputerListAppsResult,
  type ComputerListWindowsResult,
  type ComputerPermission,
  type ComputerPoint,
  type ComputerProvisionResult,
  type ComputerRect,
  type ComputerScreenSize,
  type ComputerScreenshot,
  type ComputerState,
  type ComputerStatusResult,
  type ComputerTarget,
  type ComputerVerifyStateResult,
  type ComputerWindow,
  type ComputerZoomResult,
  type ThreadComputerState,
  ThreadId,
} from "@spiritdevs/contracts";
import { encodeComputerFrame } from "@spiritdevs/shared/computerFrame";
import { FrameTransport, type FrameSink } from "@spiritdevs/shared/frameTransport";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  clampComputerMessage,
  COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
  computerBackendActionResult,
  type ComputerAgentDialect,
  type ComputerBackend,
  type ComputerBackendActionResult,
  type ComputerBackendEvent,
  type ComputerBrowserCallResult,
  type ComputerCaptureRequest,
  type ComputerMenuTarget,
  type ComputerResolvedTarget,
  type ComputerStreamFrame,
  type ComputerTextRange,
} from "./ComputerBackend.ts";
import { COMPUTER_AUDIT_LOG_FILE, makeComputerAuditLog } from "./computerAuditLog.ts";
import type { ComputerAuditEntry, ComputerAuditLog } from "./computerAuditLog.ts";
import {
  createComputerCallContext,
  cuaActionSettleMsOverride,
  cuaConditionalSettleEnabled,
  currentComputerCall,
  markComputerCall,
  timedComputerLeg,
  withComputerCallContext,
} from "./computerCallContext.ts";
import {
  type ComputerControlState,
  type ComputerControlStateError,
  makeComputerControlState,
} from "./ComputerControlState.ts";
import { ComputerDenylistError, computerDenylistMatch } from "./computerDenylist.ts";
import {
  ComputerAppApprovalRequiredError,
  ComputerBackendError,
  ComputerLeaseError,
  ComputerSpaceError,
  ComputerTargetError,
  CuaActionError,
  type ComputerOperationError,
  errorMessage,
} from "./computerErrors.ts";
import { observedComputerTargetNode } from "./computerElementIdentity.ts";
import {
  rectContainsPoint,
  topmostWindowAtPoint,
  windowsCoveringPoint,
} from "./computerGeometry.ts";
import {
  cuaMaskedActivationEnabled,
  cuaMaskedActivationOptIn,
  maskedActivationOptedIn,
} from "./computerShield.ts";
import { type ComputerSpaceBroker, makeComputerSpaceBroker } from "./ComputerSpaceBroker.ts";
import { currentComputerTask } from "./computerTaskContext.ts";
import {
  COMPUTER_FOREGROUND_NOT_REQUESTED_CODE,
  COMPUTER_FOREGROUND_USER_INTERACTION_CODE,
  COMPUTER_USER_INTERACTION_QUIET_MS,
  type ComputerForegroundAuthorization,
} from "./computerVisibleUse.ts";
import { type CursorActivity, makeCursorActivity } from "./cursorActivity.ts";
import {
  assertDesktopOperationActive,
  assertDesktopOperationAdmission,
  type DesktopAbort,
  desktopDeliveryMode,
  DesktopOperationQueue,
  desktopOperationSignal,
  desktopSignal,
  makeDesktopAbort,
  withDesktopDeliveryMode,
  withDesktopOperationSignal,
  withoutDesktopCancellation,
  checkDesktopSignal,
  composeDesktopSignals,
  type DesktopSignal,
} from "./DesktopOperationQueue.ts";
import { decodePngLuma, estimateVerticalTravel, ScrollGearingStore } from "./scrollCalibration.ts";
import { ScrollGearingFile } from "./scrollGearingFile.ts";
import {
  activationPointForNode,
  computerTargetCandidates,
  resolveComputerPoint,
  resolveComputerSemanticTarget,
  resolveComputerUniqueTextTarget,
  resolveComputerWindowTarget,
} from "./uiTreeTargeting.ts";
import { describeComputerUiTree } from "./uiTreeText.ts";
import { clampTextToLength } from "./utf8Truncation.ts";
import { waitForWindow } from "./waitForWindow.ts";

export { ComputerLeaseError };

export const COMPUTER_FRAME_QUEUE_LIMIT = 8;
export const COMPUTER_FRAME_SOCKET_BUDGET_BYTES = 2 * 1024 * 1024;

/**
 * Crash backstop for the desktop lease, not the normal release path.
 *
 * Foreground input, clipboard and complete gestures share one exclusive
 * desktop lease. A backend proving exact background delivery instead owns
 * its application's keyboard/modal state, or one window for pure semantic
 * writes. Unrelated applications can progress between atomic native actions.
 * Ownership is released the moment the owner's turn ends
 * (`releaseDesktopControl`, driven by the provider runtime's terminal turn and
 * session events), because a takeover mid-turn corrupts the owner: its drag is
 * teleported, its typing is retargeted. Idle expiry only covers the case where
 * that signal never arrives — a provider process that died without a terminal
 * event — and so is deliberately long: a model can think for minutes between
 * two tool calls, and expiring under a live turn is the failure this whole
 * mechanism exists to prevent.
 */
export const COMPUTER_LEASE_IDLE_MS = 300_000;

/**
 * How long the enable path waits for in-flight stops and the durable
 * preference write before giving up. Anything past this is wedged — and a
 * wedged enable must fail closed (staying disabled) rather than wedge the
 * caller or open authority on an unrecorded preference.
 */
export const COMPUTER_CONTROL_ENABLE_TIMEOUT_MS = 30_000;

/**
 * How long the desktop is given to settle before the screenshot that rides on
 * an action result is captured. Long enough for a menu to open or a keystroke
 * to paint, short enough not to throttle the action loop.
 */
export const COMPUTER_ACTION_SETTLE_MS = 300;

/**
 * The driver-observed settle that replaces the fixed wait when the backend
 * exposes `waitForSettle`: the AX observer debounces `actionSettleMs` of
 * notification silence after a mutation, bounded by this timeout when the
 * surface keeps churning.
 */
export const COMPUTER_ACTION_OBSERVER_SETTLE_TIMEOUT_MS = 5_000;
export const COMPUTER_ACTION_OBSERVER_SETTLE_QUIET_MS = COMPUTER_ACTION_SETTLE_MS;

/**
 * How long paste waits before restoring the user's previous clipboard. The
 * target application reads the pasteboard off the keystroke asynchronously, and
 * there is no observable "the app read it" event.
 */
export const COMPUTER_PASTE_RESTORE_MS = 250;

/**
 * Trailing-edge window on the republish that a backend window change triggers.
 * A desktop with a ticking window title would otherwise publish, observe its
 * own read as a change, and publish again without ever settling. The window
 * list itself is not delayed: `computer.windows-changed` is emitted at once.
 */
export const COMPUTER_WINDOWS_PUBLISH_DEBOUNCE_MS = 250;

/**
 * The first vertical scroll into a window whose gearing is unknown is split:
 * this many requested pixels go first as a probe whose travel is measured and
 * learned, and the remainder is delivered pre-corrected.
 */
export const SCROLL_PROBE_PX = 48;
/** Requests at or below this skip the probe: they are already probe-sized. */
export const SCROLL_PROBE_TRIGGER_PX = SCROLL_PROBE_PX;

/**
 * How close a leg's measured travel must land to its predicted distance before
 * that measurement itself counts as the settle evidence: the relative slack
 * covers animation residue on long legs, the floor covers row quantization.
 */
export const SCROLL_SETTLE_ARRIVAL_TOLERANCE = 0.15;
export const SCROLL_SETTLE_ARRIVAL_MIN_PX = 4;

/** How long recordError waits before republishing the threads it touched. */
export const COMPUTER_ERROR_REPUBLISH_DEBOUNCE_MS = 250;

/**
 * How long the running-app inventory a denylist window check resolves pids
 * through may be reused, so every click does not pay for a process
 * enumeration while a freshly-installed password manager is still refused on
 * essentially the next call.
 */
const COMPUTER_DENYLIST_APP_CACHE_MS = 30_000;

/** Bounded LRU sizes for per-thread bookkeeping that outlives a thread record. */
const KNOWN_APP_NAMES_LIMIT = 256;

interface ThreadComputerRuntimeState {
  version: number;
  lastError: string | null;
  /**
   * An error reported by a caller (stream attach, device surface), not by the
   * physical read — `publishNow` owns `lastError` and would erase it. The next
   * publish carries it in the snapshot's `lastError` slot, then clears it.
   */
  reportedError: string | null;
  inputPause?: NonNullable<ThreadComputerState["inputPause"]>;
  windows: readonly ComputerWindow[];
  screenSize: ComputerScreenSize;
  availability: ComputerAvailability;
  cursor?: ComputerPoint;
  /**
   * Whether this thread's agent activity already asked the UI to open the
   * computer pane. Surfacing is once per thread so a user who closed the pane
   * is not yanked back to it on every click.
   */
  paneSurfaced: boolean;
}

/** The single desktop's exclusive owner, and when it last drove it. */
interface DesktopLease {
  readonly threadId: string;
  readonly turnId?: string;
  lastActivityMs: number;
  releaseRequested?: boolean;
  /** The turn the deferred release was requested for — a renewed lease ignores it. */
  releaseRequestedTurnId?: string | undefined;
}

/** Semantic writes own a window; keyboard and modal state belong to its process. */
interface BackgroundControlTarget {
  readonly key: string;
  readonly pid?: number;
  readonly windowId?: string;
}

interface BackgroundLease extends DesktopLease {
  readonly target: BackgroundControlTarget;
}

/**
 * The approval gate half the manager drives: an Off or Stop withdraws the
 * thread's cards, a desktop interruption revokes standing grants, and input
 * reaches only apps the turn may drive. `ComputerApprovalGate` satisfies it.
 */
export interface ComputerManagerApprovals {
  readonly cancelThread: (threadId: string, turnId?: string) => Effect.Effect<void>;
  readonly revokeTaskGrants: Effect.Effect<void>;
  readonly appAllowed: (threadId: string, turnId: string, app: string) => boolean;
}

const NO_APPROVALS: ComputerManagerApprovals = {
  cancelThread: () => Effect.void,
  revokeTaskGrants: Effect.void,
  appAllowed: () => true,
};

export interface ComputerManagerOptions {
  readonly backend: ComputerBackend;
  /**
   * The environment state directory. Control consent, the audit log and the
   * learned scroll gearing live here. Absent keeps all three in memory, which
   * is what tests and in-memory embeddings want.
   */
  readonly stateDir?: string;
  /** Withdraws approval cards on Off/Stop. Absent means no gate is wired. */
  readonly approvals?: ComputerManagerApprovals;
  readonly transport?: FrameTransport<string, ComputerStreamFrame>;
  readonly leaseIdleMs?: number;
  /** Injected for tests, so action-screenshot tests do not wait out the real settle. */
  readonly actionSettleMs?: number;
  /** Injected for tests, so window-churn tests do not wait out the real window. */
  readonly windowsPublishDebounceMs?: number;
  /** Injected for tests; decodes and correlates two PNG captures. */
  readonly measureScrollTravel?: (
    before: Uint8Array,
    after: Uint8Array,
  ) => Effect.Effect<number | undefined>;
}

/**
 * A resolved pointer target, plus what the window read taken while resolving it
 * showed covering the point, so the raise-failure path can decide whether to
 * refuse without paying a second window read.
 */
interface ResolvedPointTarget {
  readonly point: ComputerPoint;
  readonly windowId?: string;
  readonly covering?: readonly ComputerWindow[];
  readonly semantic?: ComputerResolvedTarget;
}

/** What the raise/focus step needs; keyboard actions name a window without a point. */
type PreparedTarget = Omit<ResolvedPointTarget, "point"> & {
  readonly point?: ComputerPoint;
};

/**
 * The click variants `computer_click` folds into one call: which button, and
 * how many presses. The driver exposes left x1-3 and a single right click;
 * every other combination is refused before a target is even resolved.
 */
export interface ComputerClickGesture {
  readonly count?: 1 | 2 | 3;
  readonly button?: "left" | "right" | "middle";
}

/** A capture plus which window it covers, when it covers one at all. */
export interface ComputerCapturedWindow {
  readonly screenshot: ComputerScreenshot;
  readonly windowId?: string;
}

/** The action's captured window, or confirmation that it closed. */
export type ComputerActionObservation =
  | ComputerCapturedWindow
  | { readonly targetWindowClosed: true };

/** Whether the window found frontmost before an activation was put back. */
export type ForegroundRestoreStatus =
  | "restored"
  | "restore-missed"
  | "already-frontmost"
  | "frontmost-unobservable";

/** Which window a foreground excursion restored, and whether that succeeded. */
export interface ForegroundRestoreInfo {
  readonly restoredWindowId: string | null;
  readonly restoreStatus: ForegroundRestoreStatus;
}

/** What enabling or admitting control can fail with: an operation, or the durable write. */
export type ComputerControlError = ComputerOperationError | ComputerControlStateError;

const isComputerBackendError = Schema.is(ComputerBackendError);
const isComputerTargetError = Schema.is(ComputerTargetError);

type DenylistMatch = NonNullable<ReturnType<typeof computerDenylistMatch>>;

/** Everything `make` builds before the manager exists. */
interface ComputerManagerParts {
  readonly options: ComputerManagerOptions;
  readonly clock: Clock.Clock;
  readonly runFork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly events: PubSub.PubSub<ComputerEvent>;
  readonly controlState: ComputerControlState;
  readonly auditLog: ComputerAuditLog;
  readonly scrollGearingFile: ScrollGearingFile;
}

/** Thread state, targeting, action dispatch, and stream ownership for a computer. */
export class ComputerManager {
  readonly computerId: ComputerId;

  /**
   * Builds a manager whose timers, detached work and backend subscription live
   * in the caller's scope. Closing the scope disposes the manager.
   */
  static make(
    options: ComputerManagerOptions,
  ): Effect.Effect<ComputerManager, never, Scope.Scope | FileSystem.FileSystem | Path.Path> {
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const clock = yield* Clock.Clock;
      // Opened before the fiber set so it closes after it: operation fibers
      // unwinding at shutdown can still record what they did.
      const auditLog = yield* makeComputerAuditLog(
        options.stateDir === undefined
          ? undefined
          : path.join(options.stateDir, COMPUTER_AUDIT_LOG_FILE),
      );
      const runFork = yield* FiberSet.makeRuntime<never, unknown, unknown>();
      const events = yield* PubSub.unbounded<ComputerEvent>();
      const controlState = yield* makeComputerControlState(options.stateDir);
      const scrollGearingFile = yield* ScrollGearingFile.load(options.stateDir);
      let manager: ComputerManager | undefined;
      const cursorActivity = yield* makeCursorActivity((text) =>
        manager === undefined ? Effect.void : manager.publishCursorActivity(text),
      );
      manager = new ComputerManager(
        {
          options,
          clock,
          runFork,
          events,
          controlState,
          auditLog,
          scrollGearingFile,
        },
        cursorActivity,
      );
      const created = manager;
      yield* Effect.addFinalizer(() => created.dispose());
      if (options.backend.events) {
        // Started immediately so the subscription exists before `make` returns:
        // Synara subscribed in the constructor, and a backend event published
        // right after construction must not be lost.
        yield* options.backend.events.pipe(
          Stream.runForEach((event) => created.handleBackendEvent(event)),
          Effect.forkScoped({ startImmediately: true }),
        );
      }
      return created;
    });
  }

  private readonly backend: ComputerBackend;
  private readonly approvals: ComputerManagerApprovals;
  private readonly transport: FrameTransport<string, ComputerStreamFrame>;
  private readonly eventHub: PubSub.PubSub<ComputerEvent>;
  private readonly clock: Clock.Clock;
  /** Forks detached work into the manager's scope: Synara's un-awaited promises. */
  private readonly runFork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  /** Per-thread publish serialization; see `publish`. */
  private readonly publishChains = new Map<string, Semaphore.Semaphore>();
  /** Publishes in flight or waiting, per thread; a thread with none drops its lock. */
  private readonly publishWaiters = new Map<string, number>();
  private errorRepublishTimer: Fiber.Fiber<void> | undefined;
  private nextStateVersion = -1;
  private readonly screenshotBytes = new WeakMap<ComputerScreenshot, Uint8Array>();
  private readonly threads = new Map<string, ThreadComputerRuntimeState>();
  /**
   * Agent calls in flight, per thread. Not a field on the thread runtime record:
   * a thread can drive the desktop without any record existing, and this count
   * is what stops the desktop lease being taken from a thread whose drag or
   * keystroke is still running. Entries are deleted as they reach zero.
   */
  private readonly agentCallsInFlight = new Map<string, number>();
  private readonly backgroundLeases = new Map<string, BackgroundLease>();
  private readonly knownAppNames = new Set<string>();
  /** Display names for the agent cursor badge, keyed by thread id. */
  private readonly threadLabels = new Map<string, string>();
  private readonly leaseIdleMs: number;
  private readonly actionSettleMs: number;
  private readonly windowsPublishDebounceMs: number;
  private readonly measureScrollTravel: (
    before: Uint8Array,
    after: Uint8Array,
  ) => Effect.Effect<number | undefined>;
  /** Learned per window and kept for the manager's life; see ScrollGearingStore. */
  private readonly scrollGearing = new ScrollGearingStore();
  private readonly scrollGearingFile: ScrollGearingFile;
  /** Depth rather than a flag: a lease publish can nest inside a window one. */
  private publishAllDepth = 0;
  private windowsPublishPending = false;
  /**
   * Whether this backend answers `waitForSettle`. "unsupported" is sticky — the
   * driver and the host's tool allowlist are fixed for the backend's life — but
   * a transient failure never flips it.
   */
  private observerSettle: "unknown" | "supported" | "unsupported" = "unknown";
  private windowsPublishTimer: Fiber.Fiber<void> | undefined;
  private backendHealth: ComputerHealth;
  private lease: DesktopLease | null = null;
  /**
   * Whether anything has yet asked this backend for the desktop itself. Until
   * something has, state publishes read the passive probe: rendering a chat
   * must not be what connects to a compositor or installs a plugin.
   */
  private backendEngaged = false;
  /**
   * When the human last drove the desktop through this server's pane-input
   * paths (`threadId === undefined`). The foreground funnels read it to refuse
   * a raise while the user is actively interacting.
   */
  private lastUserDesktopInputAt: number | undefined;
  private readonly operations = new DesktopOperationQueue();
  readonly cursorActivity: CursorActivity;
  readonly spaceBroker: ComputerSpaceBroker;
  private activity: string | null = null;
  /**
   * The window ids the last window read saw, so a post-action read can be
   * diffed against it without paying for a second one. Maintained by
   * `readWindows` and by the backend's own `windows-changed` events.
   */
  private lastKnownWindowIds: ReadonlySet<string> | undefined;
  /** The same cache keyed by id, so a window id resolves without a backend read. */
  private lastKnownWindows = new Map<string, ComputerWindow>();
  /** The window ids that existed when the running action started. */
  private preActionWindowIds: ReadonlySet<string> | undefined;
  private streamAttached = false;
  private streamDesired = false;
  private streamEpoch = 0;
  /** The last queued attach/detach transition; each waits for the one before it. */
  private streamTransition: Deferred.Deferred<void> = Deferred.makeUnsafe<void>();
  private disposed = false;
  private readonly disabledThreads = new Set<string>();
  private readonly controlState: ComputerControlState;
  private readonly auditLog: ComputerAuditLog;
  /** The running-app inventory the denylist's pid resolution reuses. */
  private deniedAppsCache:
    | { readonly at: number; readonly apps: readonly ComputerApp[] }
    | undefined;
  private readonly pendingControlWrites = new Map<
    string,
    Fiber.Fiber<void, ComputerControlStateError>
  >();
  private readonly suspendedThreads = new Set<string>();
  private readonly authorityRevocations = new Map<string, DesktopAbort>();
  private readonly controlRequests = new Map<string, symbol>();
  private readonly pendingStops = new Map<string, Fiber.Fiber<void, ComputerOperationError>>();
  private physicalState:
    | {
        availability: ComputerAvailability;
        windows?: readonly ComputerWindow[];
        screenSize?: ComputerScreenSize;
      }
    | undefined;
  private physicalRead: Fiber.Fiber<void> | undefined;
  private physicalFailure: string | undefined;
  private readonly activeAuthorities = new Map<string, Set<DesktopAbort>>();
  private readonly authorityTurns = new Map<string, string>();

  private constructor(parts: ComputerManagerParts, cursorActivity: CursorActivity) {
    const { options } = parts;
    Deferred.doneUnsafe(this.streamTransition, Effect.void);
    this.backend = options.backend;
    this.approvals = options.approvals ?? NO_APPROVALS;
    this.clock = parts.clock;
    this.runFork = parts.runFork;
    this.eventHub = parts.events;
    this.controlState = parts.controlState;
    this.auditLog = parts.auditLog;
    this.scrollGearingFile = parts.scrollGearingFile;
    this.cursorActivity = cursorActivity;
    this.spaceBroker = makeComputerSpaceBroker({
      assertActive: assertDesktopOperationActive,
      readSnapshot: Effect.suspend(() => {
        if (!this.backend.listSpaces) {
          return Effect.fail(
            new ComputerSpaceError(
              "computer_spaces_unavailable",
              "This backend does not expose managed Space inventory. Drive an exact existing window in place instead.",
            ),
          );
        }
        const listSpaces = this.backend.listSpaces?.bind(this.backend);
        return Effect.gen({ self: this }, function* () {
          this.engageBackend();
          const inventory = yield* listSpaces();
          const windows = yield* this.readWindows();
          return { inventory, windows };
        });
      }),
    });
    this.computerId = options.backend.computerId;
    this.leaseIdleMs = options.leaseIdleMs ?? COMPUTER_LEASE_IDLE_MS;
    this.actionSettleMs =
      options.actionSettleMs ?? cuaActionSettleMsOverride() ?? COMPUTER_ACTION_SETTLE_MS;
    this.windowsPublishDebounceMs =
      options.windowsPublishDebounceMs ?? COMPUTER_WINDOWS_PUBLISH_DEBOUNCE_MS;
    this.measureScrollTravel = options.measureScrollTravel ?? measureScrollTravelFromPng;
    this.backendHealth = options.backend.health();
    this.transport =
      options.transport ??
      new FrameTransport<string, ComputerStreamFrame>({
        independentStills: true,
        encode: (computerId, frame) =>
          encodeComputerFrame({
            header: {
              computerId,
              sequence: frame.sequence,
              timestampMs: frame.timestampMs,
              keyframe: frame.keyframe,
              codecConfig: frame.codecConfig,
            },
            payload: frame.data,
          }),
        queueLimit: COMPUTER_FRAME_QUEUE_LIMIT,
        socketBudgetBytes: COMPUTER_FRAME_SOCKET_BUDGET_BYTES,
        subscriberIdPrefix: "computer-frame-subscriber",
      });
  }

  private now(): number {
    return this.clock.currentTimeMillisUnsafe();
  }

  /** The cursor badge changed: republish cached state, then tell the backend. */
  private publishCursorActivity(text: string | null): Effect.Effect<void, ComputerOperationError> {
    return Effect.suspend(() => {
      this.activity = text;
      for (const threadId of this.threads.keys()) this.publishCached(threadId);
      return this.backend.setCursorActivity?.(text) ?? Effect.void;
    });
  }

  private handleBackendEvent(event: ComputerBackendEvent): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (event.type === "windows-changed") {
        this.lastKnownWindowIds = windowIdSet(event.windows);
        this.lastKnownWindows = new Map(event.windows.map((window) => [window.id, window]));
        this.rememberObservedAppNames(event.windows);
        for (const state of this.threads.values()) state.windows = event.windows;
        this.emit({ type: "computer.windows-changed", windows: event.windows });
        this.scheduleWindowsPublish();
      } else if (event.type === "health-changed") {
        this.backendHealth = event.health;
        this.republishAllThreads();
      } else if (event.type === "capabilities-changed") {
        this.republishAllThreads();
      } else if (event.type === "desktop-interrupted") {
        // Locked-use resume policy: consent granted before a lock/sleep/session
        // interruption does not carry across it. The host already refuses input
        // until a fresh model observation lands; revoking the standing grants
        // adds the re-auth half.
        return this.approvals.revokeTaskGrants;
      } else if (event.type === "frame") {
        this.handleFrame(event.frame);
      }
      return Effect.void;
    });
  }

  /**
   * Every computer event, as it happens. Subscribe with `subscribeEvents` when
   * the reader must not miss what is published between subscribing and
   * pulling.
   */
  get events(): Stream.Stream<ComputerEvent> {
    return Stream.fromPubSub(this.eventHub);
  }

  /** A subscription that buffers every event published after it opens. */
  get subscribeEvents(): Effect.Effect<PubSub.Subscription<ComputerEvent>, never, Scope.Scope> {
    return PubSub.subscribe(this.eventHub);
  }

  /**
   * Which desktop vocabulary the tool descriptions must speak: the shortcut
   * form, the semantic action names, and the shape of an application
   * identifier all differ between dialects.
   */
  get agentDialect(): ComputerAgentDialect {
    return this.backend.agentDialect ?? "linux";
  }

  get supportsFocusNeutralSemanticText(): boolean {
    return this.backend.focusNeutralSemanticText === true;
  }

  /** Trusted observations only: resolving visible-use intent never performs IPC. */
  observedAppNames(): readonly string[] {
    return [...this.knownAppNames];
  }

  private rememberObservedAppNames(windows: readonly ComputerWindow[]): void {
    for (const window of windows) {
      const name = window.appName?.trim();
      if (!name) continue;
      this.knownAppNames.delete(name);
      this.knownAppNames.add(name);
    }
    while (this.knownAppNames.size > KNOWN_APP_NAMES_LIMIT) {
      this.knownAppNames.delete(this.knownAppNames.values().next().value!);
    }
  }

  /**
   * Read live rather than cached at construction: a backend that re-probes or
   * provisions may upgrade a capability, and the call is synchronous and cheap
   * by the backend contract.
   */
  private get backendCapabilities(): ComputerCapabilities {
    return this.backend.capabilities();
  }

  /** Single-flight physical read shared by every thread publish. */
  private refreshPhysicalState(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (!this.physicalRead) {
        const read = Effect.gen({ self: this }, function* () {
          this.physicalFailure = undefined;
          if (this.backendEngaged) {
            const [availability, windows, screenSize] = yield* Effect.all(
              [this.backend.availability(), this.readWindows(), this.backend.getScreenSize()],
              { concurrency: "unbounded" },
            );
            this.physicalState = { availability, windows, screenSize };
          } else {
            this.physicalState = { availability: yield* this.backend.probeAvailability() };
          }
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              this.physicalFailure = clampComputerMessage(
                errorMessage(error),
                "Computer state is unavailable.",
              );
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              this.physicalRead = undefined;
            }),
          ),
        );
        const fiber = this.runFork(read);
        // A read that finished synchronously already ran its `ensuring`;
        // caching it would pin that result for every later refresh.
        if (fiber.pollUnsafe() === undefined) this.physicalRead = fiber;
        return Fiber.join(fiber);
      }
      return Fiber.join(this.physicalRead);
    });
  }

  private controlDisabled(threadId: string): boolean {
    return this.disabledThreads.has(threadId) || this.controlState.get(threadId).disabled;
  }

  canActivateControl(threadId: string, generation = 0): boolean {
    return (
      !this.controlDisabled(threadId) &&
      !this.suspendedThreads.has(threadId) &&
      this.controlState.allows(threadId, generation)
    );
  }

  /**
   * One mutating-call record in the local audit log. Called where the call's
   * final effect is already known and never waited on: a full or broken log
   * must not delay or fail the action it records.
   *
   * The kill switch writes nothing, enforced here rather than trusted to every
   * caller: a thread whose control is off records no entries — not even the
   * refusal that stopped it.
   */
  recordComputerAudit(entry: Omit<ComputerAuditEntry, "ts">): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (entry.threadId !== undefined && this.controlDisabled(entry.threadId)) {
        return Effect.void;
      }
      return this.auditLog.record(entry);
    });
  }

  getAuditHistory(input: ComputerGetAuditHistoryInput) {
    return this.auditLog.readHistory(input);
  }

  /** Completes once every audit record queued so far has been written. */
  get flushAudit(): Effect.Effect<void> {
    return this.auditLog.flush;
  }

  /**
   * The denylist check for the admission/consent keys, which are the raw
   * strings a tool call declared — an app name, a bundle id, an executable
   * path, or the `pid <n>` fallback. Synchronous by contract, so the pid
   * fallback resolves only against the last cached inventory.
   */
  private assertDrivenAppAllowed(app: string): Effect.Effect<void, ComputerDenylistError> {
    return Effect.suspend(() => {
      const direct = computerDenylistMatch({ name: app });
      if (direct) return Effect.fail(new ComputerDenylistError(direct.app, direct.matched));
      const pidMatch = /^pid ([1-9]\d*)$/.exec(app.trim().toLowerCase());
      if (pidMatch === null) return Effect.void;
      const pid = Number(pidMatch[1]);
      const owner = this.deniedAppsCache?.apps.find((candidate) => candidate.pid === pid);
      if (owner === undefined) return Effect.void;
      const resolved = computerDenylistMatch({ name: owner.name, bundleId: owner.bundleId });
      return resolved
        ? Effect.fail(new ComputerDenylistError(resolved.app, resolved.matched))
        : Effect.void;
    });
  }

  /**
   * The running-app inventory a window's pid resolves through. The list is
   * cached briefly; a failed enumeration reuses the stale copy rather than
   * closing the check open.
   */
  private runningAppsForDenylist(): Effect.Effect<readonly ComputerApp[]> {
    return Effect.suspend(() => {
      const listApps = this.backend.listApps?.bind(this.backend);
      if (listApps === undefined) return Effect.succeed(this.deniedAppsCache?.apps ?? []);
      const now = this.now();
      const cached = this.deniedAppsCache;
      if (cached !== undefined && now - cached.at < COMPUTER_DENYLIST_APP_CACHE_MS) {
        return Effect.succeed(cached.apps);
      }
      return listApps().pipe(
        Effect.map((apps) => {
          this.deniedAppsCache = { at: now, apps };
          return apps;
        }),
        Effect.orElseSucceed(() => cached?.apps ?? []),
      );
    });
  }

  /** How a listed window's owning app matches the denylist, or nothing. */
  private deniedMatchForWindow(window: ComputerWindow): Effect.Effect<DenylistMatch | undefined> {
    return Effect.suspend(() => {
      const direct = computerDenylistMatch({ name: window.appName });
      if (direct) return Effect.succeed(direct);
      if (window.pid === undefined) return Effect.succeed(undefined);
      return Effect.map(this.runningAppsForDenylist(), (apps) => {
        const owner = apps.find((candidate) => candidate.pid === window.pid);
        return owner === undefined
          ? undefined
          : computerDenylistMatch({ name: owner.name, bundleId: owner.bundleId });
      });
    });
  }

  /** How a pid-grain target's owning app matches the denylist, or nothing. */
  private deniedMatchForPid(
    pid: number,
    name: string | undefined,
  ): Effect.Effect<DenylistMatch | undefined> {
    return Effect.suspend(() => {
      const direct = computerDenylistMatch({ name });
      if (direct) return Effect.succeed(direct);
      return Effect.map(this.runningAppsForDenylist(), (apps) => {
        const owner = apps.find((candidate) => candidate.pid === pid);
        return owner === undefined
          ? undefined
          : computerDenylistMatch({ name: owner.name, bundleId: owner.bundleId });
      });
    });
  }

  /**
   * Refuse an agent's input bound for a denylisted window. The human's own pane
   * input is exempt — `threadId` undefined identifies the person at the
   * keyboard — while every agent-driven path resolves the window's app before a
   * raise, a focus pin, or a dispatch can touch it.
   */
  private assertWindowInputAllowed(
    threadId: string | undefined,
    windowId: string,
  ): Effect.Effect<void, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      if (agentThreadId(threadId) === undefined) return;
      const window = (yield* this.readWindows()).find((candidate) => candidate.id === windowId);
      if (window === undefined) return;
      yield* this.assertWindowInputAllowedWindow(threadId, window);
      yield* this.assertAppConsented(threadId, window.appName ?? window.id);
    });
  }

  /**
   * Once-per-app consent (ADR 0043), keyed by the app the input resolved to
   * rather than anything the call declared. Only an agent's call inside its
   * task is asked about; the human at the pane never is.
   */
  private assertAppConsented(
    threadId: string | undefined,
    app: string,
  ): Effect.Effect<void, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      const owner = agentThreadId(threadId);
      const turnId = (yield* currentComputerTask)?.turnId;
      if (owner === undefined || turnId === undefined) return;
      if (!this.approvals.appAllowed(owner, turnId, app)) {
        return yield* new ComputerAppApprovalRequiredError(app);
      }
    });
  }

  /** The same input check for a window the caller already listed. */
  private assertWindowInputAllowedWindow(
    threadId: string | undefined,
    window: ComputerWindow,
  ): Effect.Effect<void, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      const owner = agentThreadId(threadId);
      if (owner === undefined) return;
      const match = yield* this.deniedMatchForWindow(window);
      if (match) return yield* new ComputerDenylistError(match.app, match.matched);
      const task = yield* currentComputerTask;
      yield* this.spaceBroker.assertWindowAllowed(
        { threadId: threadId!, turnId: task?.turnId ?? null },
        window,
      );
    });
  }

  private assertSpaceAppMutationAllowed(
    threadId: string | undefined,
    pid: number,
  ): Effect.Effect<void, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      const owner = agentThreadId(threadId);
      if (owner === undefined) return;
      const task = yield* currentComputerTask;
      yield* this.spaceBroker.assertAppMutationAllowed(
        { threadId: owner, turnId: task?.turnId ?? null },
        pid,
      );
    });
  }

  /**
   * Refuse a scoped read of a denylisted window — state, element tree, zoomed
   * capture, verify — for every caller, pane included. The accessibility tree
   * of a password manager carries field values; presence stays visible
   * through `list_windows`.
   */
  private assertWindowContentAllowed(
    windowId: string,
  ): Effect.Effect<void, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      const window = (yield* this.readWindows()).find((candidate) => candidate.id === windowId);
      if (window === undefined) return;
      const match = yield* this.deniedMatchForWindow(window);
      if (match) return yield* new ComputerDenylistError(match.app, match.matched);
    });
  }

  /**
   * The visible denylisted windows. Unscoped content reads cannot exclude a
   * visible denied surface's pixels or elements, so they refuse while one is
   * shown.
   */
  private deniedVisibleWindows(): Effect.Effect<
    ReadonlyArray<{ readonly window: ComputerWindow; readonly match: DenylistMatch }>,
    ComputerOperationError
  > {
    return Effect.gen({ self: this }, function* () {
      const denied: Array<{ readonly window: ComputerWindow; readonly match: DenylistMatch }> = [];
      for (const window of yield* this.readWindows()) {
        if (!window.visible || window.minimized) continue;
        const match = yield* this.deniedMatchForWindow(window);
        if (match) denied.push({ window, match });
      }
      return denied;
    });
  }

  private deniedVisibleWindow() {
    return Effect.map(this.deniedVisibleWindows(), (denied) => denied[0]);
  }

  /** Whether a window id names a denylisted surface; for best-effort observation skips. */
  private windowIsDenied(windowId: string): Effect.Effect<boolean, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      const window = (yield* this.readWindows()).find((candidate) => candidate.id === windowId);
      return window !== undefined && (yield* this.deniedMatchForWindow(window)) !== undefined;
    });
  }

  admitControl(
    threadId: string,
    mode: ComputerControlMode,
    generation = 0,
    explicitInvocation = false,
  ): Effect.Effect<boolean, ComputerControlError> {
    return Effect.gen({ self: this }, function* () {
      // A fresh user invocation can re-arm a stopped task. An invocation queued
      // before Stop still carries the old generation and cannot revive input.
      // Waiting out the in-flight control write is what keeps a stale
      // invocation from slipping the gap.
      if (explicitInvocation && mode === "request" && this.controlDisabled(threadId)) {
        const pending = this.pendingControlWrites.get(threadId);
        if (pending) yield* Fiber.await(pending);
      }
      if (
        explicitInvocation &&
        mode === "request" &&
        this.controlState.get(threadId).generation === generation &&
        !this.suspendedThreads.has(threadId) &&
        this.controlDisabled(threadId)
      ) {
        yield* this.setControlEnabled(threadId, true);
      }
      const enabled = mode !== "off" && this.canActivateControl(threadId, generation);
      // Request admission lasts through this turn's tool loop and approval
      // waits. Only an explicit chat default survives into later turns.
      yield* this.controlState
        .recordChatIntent(threadId, enabled && mode === "chat", generation)
        .pipe(
          Effect.tapError(() =>
            Effect.gen({ self: this }, function* () {
              // Fail closed and loud: a persist failure means durable intent is
              // unrecorded, so the thread is disabled.
              yield* Effect.logWarning(
                "[computer] admitControl persist failed, disabling thread",
              ).pipe(Effect.annotateLogs({ threadId, mode, generation }));
              this.disabledThreads.add(threadId);
            }),
          ),
        );
      return enabled && this.canActivateControl(threadId, generation);
    });
  }

  canContinueChatControl(threadId: string): boolean {
    const state = this.controlState.get(threadId);
    return (
      state.chatGeneration === state.generation &&
      this.canActivateControl(threadId, state.generation)
    );
  }

  setControlEnabled(
    threadId: string,
    enabled: boolean,
  ): Effect.Effect<{ enabled: boolean; generation: number }, ComputerControlError> {
    return Effect.gen({ self: this }, function* () {
      const request = Symbol();
      this.controlRequests.set(threadId, request);
      if (enabled) {
        // The durable gate stays closed until the new preference is on disk:
        // `disabledThreads` is held through the write, and a write that hangs
        // past the timeout fails with the gate still held (fail closed).
        yield* withControlEnableTimeout(this.pendingControlWrites.get(threadId));
        yield* withControlEnableTimeout(this.pendingStops.get(threadId));
        if (this.controlRequests.get(threadId) === request) {
          this.disabledThreads.add(threadId);
          const write = this.runFork(this.controlState.set(threadId, false));
          this.pendingControlWrites.set(threadId, write);
          yield* withControlEnableTimeout(write);
          if (this.controlRequests.get(threadId) === request) {
            this.disabledThreads.delete(threadId);
            const revocation = this.authorityRevocations.get(threadId);
            if (revocation && Deferred.isDoneUnsafe(revocation)) {
              this.authorityRevocations.delete(threadId);
            }
          }
        }
      } else {
        this.disabledThreads.add(threadId);
        const runtime = this.threads.get(threadId);
        if (runtime) runtime.paneSurfaced = false;
        // Bump immediately, before cleanup or persistence can yield: old queued
        // requests never regain authority when this thread is re-enabled.
        const write = this.runFork(this.controlState.set(threadId, true));
        this.pendingControlWrites.set(threadId, write);
        const stop = yield* this.revokeControl(threadId);
        // Bounded like the enable path: the disable itself already holds, so a
        // wedged stop cannot strand the RPC — it can only cost the confirmation.
        const outcomes = yield* withControlTeardownTimeout(
          Effect.all([Fiber.await(write), Fiber.await(stop)]),
        );
        const [written, stopped] = outcomes;
        if (Exit.isFailure(written)) return yield* Effect.failCause(written.cause);
        if (Exit.isFailure(stopped)) return yield* Effect.failCause(stopped.cause);
      }
      if (this.controlRequests.get(threadId) === request) {
        this.controlRequests.delete(threadId);
        this.pendingControlWrites.delete(threadId);
      }
      // A thread mid-removal has no pane to update — publishing here would
      // resurrect a runtime record the removal is trying to delete.
      if (!this.suspendedThreads.has(threadId)) {
        this.threadRuntime(threadId);
        this.publishCached(threadId);
      }
      return {
        enabled: !this.controlDisabled(threadId) && !this.suspendedThreads.has(threadId),
        generation: this.controlState.get(threadId).generation,
      };
    });
  }

  /**
   * Withdraws the thread's approval cards and aborts its live and admitted
   * work at once, then stops input and releases its leases on a detached
   * fiber shared by concurrent revocations.
   */
  private revokeControl(
    threadId: string,
  ): Effect.Effect<Fiber.Fiber<void, ComputerOperationError>> {
    return Effect.gen({ self: this }, function* () {
      // Settle pending approval prompts now: a mid-turn Off must not leave a
      // prompt hanging until the gate's five-minute timeout.
      yield* this.approvals.cancelThread(threadId);
      const revokeReason = new ComputerBackendError({
        message:
          "Computer control was revoked for this conversation; no new input may be dispatched.",
        controlRevoked: true,
      });
      // Read before the aborts below: an aborted live call drops its authority
      // entry as it unwinds, which can land before the detached stop runs.
      const holdsInput =
        this.lease?.threadId === threadId ||
        [...this.backgroundLeases.values()].some((lease) => lease.threadId === threadId) ||
        (this.activeAuthorities.get(threadId)?.size ?? 0) > 0;
      const turnId = this.authorityTurns.get(threadId);
      const revocation = this.authorityRevocations.get(threadId);
      if (revocation) Deferred.doneUnsafe(revocation, Effect.fail(revokeReason));
      // Live ops get the same reason: a call cancelled by an Off must classify
      // as control-revoked, not a retryable abort.
      for (const abort of this.activeAuthorities.get(threadId) ?? []) {
        Deferred.doneUnsafe(abort, Effect.fail(revokeReason));
      }
      const pending = this.pendingStops.get(threadId);
      if (pending) return pending;
      const stop = this.runFork(
        Effect.gen({ self: this }, function* () {
          if (holdsInput) {
            yield* (
              this.backend.stopInput?.({ threadId, ...(turnId ? { turnId } : {}) }) ?? Effect.void
            );
          }
          yield* this.releaseDesktopControl(threadId);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              this.pendingStops.delete(threadId);
            }),
          ),
        ),
      );
      // A stop that already finished must not be remembered as pending.
      if (stop.pollUnsafe() === undefined) this.pendingStops.set(threadId, stop);
      return stop;
    });
  }

  /**
   * The refusal every admitted input path shares for a thread whose control
   * was switched off or suspended. `undefined` is pane input, which belongs to
   * no thread and is exempt — the human's own kill switch does not lock the
   * human out.
   */
  private assertControlAuthority(
    owner: string | undefined,
  ): Effect.Effect<void, ComputerBackendError> {
    return Effect.suspend(() => {
      if (owner === undefined) return Effect.void;
      if (!this.controlDisabled(owner) && !this.suspendedThreads.has(owner)) return Effect.void;
      return Effect.fail(
        new ComputerBackendError({
          message: "Computer control was revoked for this conversation; no input was dispatched.",
          controlRevoked: true,
        }),
      );
    });
  }

  /** A thread the host paused is refused before it can claim the desktop or dispatch. */
  private assertInputNotPaused(
    owner: string | undefined,
  ): Effect.Effect<void, ComputerBackendError> {
    return Effect.suspend(() => {
      const pausedState = owner ? this.threads.get(owner) : undefined;
      if (!pausedState?.inputPause) return Effect.void;
      return Effect.fail(
        new ComputerBackendError({
          message: pausedState.inputPause.message,
          inputPause: pausedState.inputPause,
        }),
      );
    });
  }

  /**
   * The never-raise gate every foreground excursion passes before it can move a
   * window in front of the user. Two `not-dispatched` refusals: the user's task
   * never asked to see the app or window, or the user was interacting with the
   * desktop moments ago. Absent authorization is a refusal, not a default.
   * Pane input is exempt: the gate exists to protect the user from us. It runs
   * inside the queued action (dispatch time), which is what makes the
   * interaction stamp meaningful for a call that waited behind pane input.
   */
  private assertForegroundAllowed(
    threadId: string | undefined,
    authorization: ComputerForegroundAuthorization | undefined,
  ): Effect.Effect<void, CuaActionError> {
    return Effect.suspend(() => {
      if (agentThreadId(threadId) === undefined) return Effect.void;
      if (authorization?.userRequestedVisibleUse !== true) {
        return Effect.fail(
          new CuaActionError(
            "The user's task did not ask for this app or window to be shown. Stay in the background: " +
              "keep observing and acting through background input, or ask the user to confirm " +
              "they want to watch — their reply that asks to see the screen authorizes the raise.",
            "not-dispatched",
            COMPUTER_FOREGROUND_NOT_REQUESTED_CODE,
          ),
        );
      }
      const lastInput = this.lastUserDesktopInputAt;
      if (lastInput !== undefined && this.now() - lastInput < COMPUTER_USER_INTERACTION_QUIET_MS) {
        return Effect.fail(
          new CuaActionError(
            "The user was interacting with the desktop moments ago; bringing a window forward " +
              "now would take their focus. Wait for the desktop to be quiet, then retry if the " +
              "task still needs foreground delivery.",
            "not-dispatched",
            COMPUTER_FOREGROUND_USER_INTERACTION_CODE,
          ),
        );
      }
      return Effect.void;
    });
  }

  /**
   * Record an input pause a dispatch reported: the state publishes so panels
   * show the gate, but only a still-authorized thread's own record is written.
   */
  private recordInputPause(owner: string | undefined, error: unknown): void {
    if (
      owner &&
      !this.disposed &&
      !this.suspendedThreads.has(owner) &&
      !this.controlDisabled(owner) &&
      isComputerBackendError(error) &&
      error.inputPause
    ) {
      this.threadRuntime(owner).inputPause = error.inputPause;
      this.publishCached(owner);
    }
  }

  /**
   * The manager side of the physical Escape interrupt.
   *
   * Momentary by contract: the press aborts every in-flight operation signal
   * and every admission broadcast, so live calls fail with the stop's own
   * `controlRevoked` classification and queued work fails at its wait instead
   * of dispatching after the press. The OS-level held-input release is the
   * backend's `stopInput`. Nothing latches: the next admitted action
   * dispatches normally.
   */
  emergencyStopInput(): Effect.Effect<void, ComputerOperationError> {
    return Effect.suspend(() => {
      if (this.disposed) return Effect.void;
      // Announced before the abort so a client hears the interrupt even if the
      // backend stop wedges; the closing event is delivered with the stop.
      this.emit({ type: "computer.input-stopped", stopped: true });
      const stopReason = new ComputerBackendError({
        message: "Computer input was stopped with the Escape key; no new input may be dispatched.",
        controlRevoked: true,
      });
      for (const authority of this.authorityRevocations.values()) {
        Deferred.doneUnsafe(authority, Effect.fail(stopReason));
      }
      for (const live of this.activeAuthorities.values()) {
        for (const abort of live) Deferred.doneUnsafe(abort, Effect.fail(stopReason));
      }
      return (this.backend.stopInput?.() ?? Effect.void).pipe(
        Effect.ensuring(
          Effect.sync(() => this.emit({ type: "computer.input-stopped", stopped: false })),
        ),
      );
    });
  }

  /**
   * Marks the desktop as wanted, and repaints every panel once it is. Called by
   * every path about to use the backend for a real reason — an agent tool call,
   * a pane attach, pane input — and by nothing else. The republish runs
   * detached because the caller must not wait for a window enumeration.
   */
  private engageBackend(): void {
    if (this.backendEngaged || this.disposed) return;
    this.backendEngaged = true;
    this.runFork(Effect.ignore(this.publishAllThreads()));
  }

  availability(): Effect.Effect<ComputerAvailability, ComputerOperationError> {
    return Effect.suspend(() => {
      this.engageBackend();
      return this.backend.availability();
    });
  }

  /**
   * OS privacy grants the backend lacks now. A probe that fails answers
   * "nothing missing": a backend that cannot be asked is a health problem, not
   * a grant the user is being told to go and give.
   */
  missingPermissions(): Effect.Effect<readonly ComputerPermission[]> {
    return Effect.suspend(() =>
      (this.backend.missingPermissions?.() ?? Effect.succeed([])).pipe(
        Effect.orElseSucceed(() => []),
      ),
    );
  }

  /** How the backend's build is code-signed, when it knows. Free to read. */
  buildSignature(): ComputerBuildSignature | undefined {
    return this.backend.buildSignature?.();
  }

  /**
   * Thread-independent status for surfaces outside any conversation. A probe
   * failure becomes `backend-unavailable` rather than an error. Before first
   * engagement it answers from the side-effect-free probe, so opening settings
   * never installs anything.
   */
  getStatus(): Effect.Effect<ComputerStatusResult> {
    return Effect.gen({ self: this }, function* () {
      const availability = yield* (
        this.backendEngaged
          ? this.backend.availability({ refresh: true })
          : this.backend.probeAvailability()
      ).pipe(
        Effect.catch((error) =>
          Effect.succeed<ComputerAvailability>({
            kind: "backend-unavailable",
            message: clampComputerMessage(errorMessage(error), "The computer backend failed."),
          }),
        ),
      );
      return {
        computerId: this.computerId,
        availability: this.correctedAvailability(availability),
        health: this.backendHealth,
        capabilities: this.backendCapabilities,
        provisionable: this.backend.provision !== undefined,
      };
    });
  }

  /**
   * Set this desktop up, then answer with what it looks like now. Engages the
   * backend first: the user pressing "Set up" is exactly the real reason
   * `engageBackend` waits for.
   */
  provision(): Effect.Effect<ComputerProvisionResult, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      this.engageBackend();
      if (!this.backend.provision) {
        return yield* new ComputerBackendError({
          message: "This desktop backend has nothing to install.",
        });
      }
      // Composed from output nothing here controls, so it is clamped before it
      // can fail the encode of a provision that actually succeeded.
      const summary = clampTextToLength(
        yield* this.backend.provision(),
        COMPUTER_PROVISION_SUMMARY_MAX_LENGTH,
      );
      return { summary, status: yield* this.getStatus() };
    });
  }

  /**
   * Every window read this class makes, with the resulting id set remembered,
   * so the post-action observer can answer "did this action open a window?"
   * against whatever the last read already saw.
   */
  private readWindows(): Effect.Effect<readonly ComputerWindow[], ComputerOperationError> {
    return Effect.map(this.backend.listWindows(), (windows) => {
      this.lastKnownWindowIds = windowIdSet(windows);
      this.lastKnownWindows = new Map(windows.map((window) => [window.id, window]));
      this.rememberObservedAppNames(windows);
      return windows;
    });
  }

  listWindows(): Effect.Effect<ComputerListWindowsResult, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      this.engageBackend();
      const [availability, windows] = yield* Effect.all(
        [this.backend.availability(), this.readWindows()],
        { concurrency: "unbounded" },
      );
      return { computerId: this.computerId, windows, availability };
    });
  }

  /**
   * One perception read, with the accessibility tree and its prose rendering
   * asked for separately: the walk is the expensive part and stays opt-in, and
   * the rendering happens only for callers that display it.
   */
  getState(
    options: {
      readonly includeScreenshot?: boolean;
      /** Render `root` to accessibility text. Implies `includeTree`. */
      readonly includeText?: boolean;
      /** Walk the accessibility tree. Defaults to whatever `includeText` asked for. */
      readonly includeTree?: boolean;
      readonly windowId?: string;
    } = {},
  ): Effect.Effect<ComputerState, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      this.engageBackend();
      // A scoped read of a denied window refuses outright. An unscoped read
      // refuses only what it would actually contain: a workspace screenshot on
      // every dialect, a desktop-wide tree only where the backend walks one.
      if (options.windowId !== undefined) {
        yield* this.assertWindowContentAllowed(options.windowId);
      } else if (
        options.includeScreenshot === true ||
        ((options.includeTree === true || options.includeText === true) &&
          this.agentDialect !== "macos")
      ) {
        const denied = yield* this.deniedVisibleWindow();
        if (denied) return yield* new ComputerDenylistError(denied.match.app, denied.match.matched);
      }
      // Availability rides alongside so the primary perception tool can say
      // "the OS is withholding a grant".
      const [state, availability] = yield* Effect.all(
        [
          this.backend.getState({
            ...(options.includeScreenshot !== undefined
              ? { includeScreenshot: options.includeScreenshot }
              : {}),
            includeTree: options.includeTree ?? options.includeText === true,
            ...(options.windowId ? { windowId: options.windowId } : {}),
          }),
          this.backend.availability(),
        ],
        { concurrency: "unbounded" },
      );
      // A fresh, scoped observation is the recovery boundary. Merely capturing
      // pixels or waiting does not establish that input is possible again.
      if (options.windowId) yield* this.refreshInputPause(options.windowId, state.windows);
      const inputPause =
        (this.lease ? this.threads.get(this.lease.threadId)?.inputPause : undefined) ??
        (options.windowId
          ? [...this.threads.values()].find(
              (thread) => thread.inputPause?.windowId === options.windowId,
            )?.inputPause
          : undefined);
      const withAvailability = {
        ...state,
        availability: this.correctedAvailability(availability),
        ...(inputPause ? { inputPause } : {}),
      };
      if (options.includeText !== true || !withAvailability.root) return withAvailability;
      return { ...withAvailability, text: describeComputerUiTree(withAvailability.root) };
    });
  }

  /** Zoomed capture of one window or desktop region, with its pixel mapping. */
  captureScreenshot(
    request: ComputerCaptureRequest,
  ): Effect.Effect<ComputerScreenshot, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      this.engageBackend();
      if (request.kind === "window") {
        yield* this.assertWindowContentAllowed(request.windowId);
      } else {
        // A region is refused only where a visible denied window's bounds
        // actually intersect it.
        const denied = (yield* this.deniedVisibleWindows()).find(
          (entry) =>
            entry.window.bounds !== undefined && rectsOverlap(entry.window.bounds, request.region),
        );
        if (denied) return yield* new ComputerDenylistError(denied.match.app, denied.match.matched);
      }
      return yield* this.backend.captureScreenshot(request);
    });
  }

  /**
   * The explicit agent-facing settle wait: validate the exact window, then let
   * the driver's AX observer debounce its surface until quiet — or, when this
   * backend cannot answer `waitForSettle`, fall back to the fixed pause and say
   * so. Never sends input, never raises the window.
   */
  waitForSettle(
    windowId: string,
    timeoutMs: number,
  ): Effect.Effect<
    {
      readonly settled: boolean;
      readonly waitedMs: number;
      readonly eventsSeen?: number;
      readonly mode: "observer" | "fixed";
    },
    ComputerOperationError
  > {
    return Effect.suspend(() => {
      this.engageBackend();
      return this.withComputerCall(
        Effect.gen({ self: this }, function* () {
          yield* markComputerCall("computer_wait_settle");
          const window = (yield* this.readWindows()).find((entry) => entry.id === windowId);
          if (!window) return yield* windowNotFoundError(windowId);
          const timeout = Math.max(
            0,
            Math.min(COMPUTER_ACTION_OBSERVER_SETTLE_TIMEOUT_MS * 6, Math.floor(timeoutMs)),
          );
          const waitForSettle = this.backend.waitForSettle?.bind(this.backend);
          if (this.observerSettle !== "unsupported" && waitForSettle !== undefined) {
            const outcome = yield* waitForSettle({
              windowId,
              timeoutMs: timeout,
              quietMs: this.actionSettleMs,
            }).pipe(
              Effect.map((result) => ({ result })),
              // A permanent refusal falls through to the fixed wait; a
              // transient one propagates — a guessed quiet window would lie
              // about what was verified.
              Effect.catchIf(settlePermanentlyUnsupported, () =>
                Effect.sync(() => {
                  this.observerSettle = "unsupported";
                  return undefined;
                }),
              ),
            );
            if (outcome !== undefined) {
              this.observerSettle = "supported";
              (yield* currentComputerCall)?.timing?.count(
                outcome.result.settled ? "settle_observer_settled" : "settle_observer_timeout",
              );
              return { ...outcome.result, mode: "observer" as const };
            }
          }
          const waitedMs = Math.min(timeout, Math.max(0, this.actionSettleMs));
          yield* Effect.sleep(waitedMs);
          return { settled: true, waitedMs, mode: "fixed" as const };
        }),
      );
    });
  }

  /**
   * Zoomed capture of the window that holds input focus, falling back to the
   * whole workspace when no visible window with known bounds has it: "show me
   * where input is going", at window resolution.
   */
  captureFocusedWindow(
    maxDimension?: number,
    options: { readonly agentFocusOnly?: boolean } = {},
  ): Effect.Effect<ComputerCapturedWindow, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      this.engageBackend();
      const limit = maxDimension === undefined ? {} : { maxDimension };
      const window = yield* this.focusedCapturableWindow(options.agentFocusOnly === true);
      if (window) {
        const denied = yield* this.deniedMatchForWindow(window);
        if (denied) return yield* new ComputerDenylistError(denied.app, denied.matched);
        return {
          screenshot: yield* this.backend.captureScreenshot({
            kind: "window",
            windowId: window.id,
            ...limit,
          }),
          windowId: window.id,
        };
      }
      // The whole-workspace fallback photographs every visible window, so a
      // denied one on screen refuses the capture entirely.
      const deniedVisible = yield* this.deniedVisibleWindow();
      if (deniedVisible) {
        return yield* new ComputerDenylistError(
          deniedVisible.match.app,
          deniedVisible.match.matched,
        );
      }
      const screenSize = yield* this.backend.getScreenSize();
      return {
        screenshot: yield* this.backend.captureScreenshot({
          kind: "region",
          region: { x: 0, y: 0, width: screenSize.width, height: screenSize.height },
          ...limit,
        }),
      };
    });
  }

  /**
   * Best-effort perception for an action that already happened: wait for the UI
   * to settle, then capture the window the action affected — the caller's hint,
   * otherwise the window under the action's own point, otherwise the agent's
   * own focus target. Failures return no screenshot instead of failing, because
   * the action itself succeeded.
   *
   * A hinted window that has vanished is reported as `targetWindowClosed`,
   * never replaced by another window: the focused window is the human's
   * whenever the agent's target is gone, and photographing it both leaks their
   * screen and convinces the agent its click landed there.
   */
  captureActionScreenshot(
    windowIdHint?: string,
    actionPoint?: ComputerPoint,
    threadId?: string,
    settle = true,
  ): Effect.Effect<ComputerActionObservation | undefined, ComputerOperationError> {
    return this.withComputerCall(
      Effect.gen({ self: this }, function* () {
        // A name only when the call did not already take one.
        yield* markComputerCall("computer_observe");
        if (!this.backendCapabilities.capture) return undefined;
        this.engageBackend();
        if (settle && this.actionSettleMs > 0) {
          if (yield* this.actionEffectAlreadyProven()) {
            (yield* currentComputerCall)?.timing?.count("settle_skipped");
          } else {
            yield* timedComputerLeg("settle", this.settleAfterAction(windowIdHint));
          }
        }
        return yield* timedComputerLeg(
          "observe",
          this.captureActionObservation(windowIdHint, actionPoint, threadId),
        );
      }),
    );
  }

  /**
   * The conditional-settle waiver. True requires positive effect proof — the
   * action's `verified` effect or its `confirmed` delivery read-back. The proof
   * is consumed either way, so it can never waive a later call's settle.
   */
  private actionEffectAlreadyProven(): Effect.Effect<boolean> {
    return Effect.gen(function* () {
      if (!cuaConditionalSettleEnabled()) return false;
      const proof = (yield* currentComputerCall)?.takeActionProof();
      return proof?.effect === "verified" || proof?.verified === "confirmed";
    });
  }

  /**
   * One post-action wait. The driver's AX observer is preferred whenever the
   * call knows the target window and the backend offers `waitForSettle`: a
   * quiet surface resolves early and a churning one outlasts the fixed
   * budget. A driver or host that does not know the tool is remembered as
   * "unsupported" so later actions skip straight to the fixed wait; every
   * other failure — stale window, retired generation, cancelled call — only
   * falls back for this action, and none of it can ever be grounds to replay
   * the action itself.
   */
  private settleAfterAction(windowId: string | undefined): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const waitForSettle = this.backend.waitForSettle?.bind(this.backend);
      if (
        windowId !== undefined &&
        this.observerSettle !== "unsupported" &&
        waitForSettle !== undefined
      ) {
        const outcome = yield* Effect.result(
          waitForSettle({
            windowId,
            timeoutMs: COMPUTER_ACTION_OBSERVER_SETTLE_TIMEOUT_MS,
            quietMs: this.actionSettleMs,
          }),
        );
        const timing = (yield* currentComputerCall)?.timing;
        if (outcome._tag === "Success") {
          this.observerSettle = "supported";
          timing?.count(
            outcome.success.settled ? "settle_observer_settled" : "settle_observer_timeout",
          );
          return;
        }
        if (settlePermanentlyUnsupported(outcome.failure)) this.observerSettle = "unsupported";
        timing?.count("settle_observer_unavailable");
        // Fall through to the fixed wait — the action still needs its pause.
      }
      yield* Effect.sleep(this.actionSettleMs);
    });
  }

  private captureActionObservation(
    windowIdHint: string | undefined,
    actionPoint: ComputerPoint | undefined,
    threadId: string | undefined,
  ): Effect.Effect<ComputerActionObservation | undefined> {
    return Effect.gen({ self: this }, function* () {
      if (windowIdHint !== undefined) {
        // An action's own observation must not become a way to photograph a
        // denied surface: the action already ran, so the miss reports no
        // screenshot rather than refusing the call.
        if (yield* this.windowIsDenied(windowIdHint).pipe(Effect.orElseSucceed(() => false))) {
          return undefined;
        }
        const captured = yield* Effect.option(
          this.backend.captureScreenshot({
            kind: "window",
            windowId: windowIdHint,
            maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
          }),
        );
        if (Option.isSome(captured)) {
          return yield* this.observeActionCapture(
            { screenshot: captured.value, windowId: windowIdHint },
            threadId,
          );
        }
        // The listing failing too reports nothing rather than guessing.
        const windows = yield* Effect.option(this.readWindows());
        if (Option.isSome(windows) && !windows.value.some((window) => window.id === windowIdHint)) {
          return { targetWindowClosed: true } as const;
        }
        return undefined;
      }
      if (actionPoint) {
        const pointWindowId = yield* this.windowIdAtActionPoint(actionPoint);
        if (pointWindowId !== undefined) {
          if (yield* this.windowIsDenied(pointWindowId).pipe(Effect.orElseSucceed(() => false))) {
            return undefined;
          }
          // The window may vanish between the listing and the capture. It was
          // never named by the caller, so fall through to the focus path
          // rather than reporting a close the caller did not ask about.
          const captured = yield* Effect.option(
            this.backend.captureScreenshot({
              kind: "window",
              windowId: pointWindowId,
              maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
            }),
          );
          if (Option.isSome(captured)) {
            return yield* this.observeActionCapture(
              { screenshot: captured.value, windowId: pointWindowId },
              threadId,
            );
          }
        }
      }
      const focused = yield* Effect.option(
        this.captureFocusedWindow(COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION, {
          agentFocusOnly: true,
        }),
      );
      return Option.isSome(focused)
        ? yield* this.observeActionCapture(focused.value, threadId)
        : undefined;
    });
  }

  /**
   * The observation, with one more question asked before an unchanged frame is
   * reported: did this action open a window the capture could not have shown?
   *
   * The observer photographs exactly one window — the one the action named, or
   * the one under its coordinates — so a click that opens a dialog, a menu, or
   * a new browser window photographs the *old* window, which very often did not
   * change a pixel. Diffing the window list against what existed before the
   * action answers it truthfully: a window that was not there before is the
   * outcome, so photograph that instead. Best effort — a perception failure
   * must never turn the action's success into an error.
   */
  private observeActionCapture(
    capture: ComputerCapturedWindow,
    _threadId?: string,
  ): Effect.Effect<ComputerActionObservation> {
    return Effect.gen({ self: this }, function* () {
      const appeared = yield* this.windowOpenedByAction(capture.windowId);
      if (appeared === undefined) return capture;
      // A denied window the action opened — a password prompt, a security
      // dialog — is never photographed either; the original capture stands.
      if ((yield* this.deniedMatchForWindow(appeared)) !== undefined) return capture;
      return yield* this.backend
        .captureScreenshot({
          kind: "window",
          windowId: appeared.id,
          maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
        })
        .pipe(
          Effect.map(
            (screenshot): ComputerActionObservation => ({
              screenshot,
              windowId: appeared.id,
            }),
          ),
          Effect.orElseSucceed(() => capture),
        );
    });
  }

  /**
   * A capturable window that did not exist when the running action started, or
   * nothing — including when there is no baseline to compare against, because a
   * guess here would photograph a window the action had no hand in.
   *
   * The topmost such window wins: a click that spawns a dialog over its own
   * parent produces the dialog on top, and that is the one the agent needs to
   * see.
   */
  private windowOpenedByAction(
    excludeWindowId: string | undefined,
  ): Effect.Effect<ComputerWindow | undefined> {
    return Effect.gen({ self: this }, function* () {
      const baseline = this.preActionWindowIds;
      if (baseline === undefined) return undefined;
      const read = yield* Effect.option(this.readWindows());
      if (Option.isNone(read)) return undefined;
      const windows = read.value;
      const owner = windows.find((window) => window.id === excludeWindowId);
      // A new notification/menu in the person's application is not an outcome
      // of our action. Never replace the target's image with an unrelated app.
      if (!owner) return undefined;
      return windows
        .filter(
          (window) =>
            !baseline.has(window.id) &&
            window.id !== excludeWindowId &&
            (owner.pid !== undefined
              ? window.pid === owner.pid
              : owner.appName !== undefined && window.appName === owner.appName) &&
            window.bounds !== undefined &&
            window.visible &&
            !window.minimized,
        )
        .toSorted(byStackingIndex)[0];
    });
  }

  /**
   * The window an unscoped pointer action at `point` was delivered to, by the
   * same topmost-at-point rule the compositor routes it with. Unresolvable
   * stacking returns nothing rather than a guess; a listing failure does too,
   * because this only feeds perception.
   */
  private windowIdAtActionPoint(point: ComputerPoint): Effect.Effect<string | undefined> {
    return this.readWindows().pipe(
      Effect.map((windows) => topmostWindowAtPoint(windows, point)?.id),
      Effect.orElseSucceed(() => undefined),
    );
  }

  /**
   * The window an untargeted capture should cover: the agent seat's focus
   * target first, then the window the compositor reports active, then the
   * topmost visible one. Windows without bounds cannot be captured, so they
   * are skipped rather than attempted. `agentFocusOnly` stops after the first
   * step: action observation must not drift to the human's active window
   * when the agent's focus is nowhere.
   */
  private focusedCapturableWindow(
    agentFocusOnly = false,
  ): Effect.Effect<ComputerWindow | undefined, ComputerOperationError> {
    return Effect.map(this.readWindows(), (windows) => {
      const candidates = windows.filter(
        (window) => window.bounds !== undefined && window.visible && !window.minimized,
      );
      const agentFocused = candidates.find((window) => window.focused);
      if (agentFocused !== undefined || agentFocusOnly) return agentFocused;
      return (
        candidates.find((window) => window.active === true) ??
        candidates.toSorted(byStackingIndex)[0]
      );
    });
  }

  getScreenSize(): Effect.Effect<ComputerGetScreenSizeResult, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      this.engageBackend();
      const [availability, screenSize] = yield* Effect.all(
        [this.backend.availability(), this.backend.getScreenSize()],
        { concurrency: "unbounded" },
      );
      return { computerId: this.computerId, screenSize, availability };
    });
  }

  /**
   * A verified background backend reserves the launched app; other backends
   * keep the desktop lease because their launch may use shared input state.
   *
   * A background launch must still create a usable window. Hiding an app is
   * a separate, explicit option; it is not the default for background work.
   * Readiness is checked separately from LaunchServices accepting the request.
   */
  launchApp(
    threadId: string | undefined,
    app: string,
    args: readonly string[] = [],
    waitForWindowMs = 0,
    options?: { readonly hidden?: boolean },
  ): Effect.Effect<ComputerLaunchAppResult, ComputerOperationError> {
    return this.withBackgroundAppControl(
      threadId,
      app,
      Effect.gen({ self: this }, function* () {
        yield* markComputerCall("computer_launch_app");
        yield* assertDesktopOperationActive;
        yield* this.assertDrivenAppAllowed(app);
        yield* this.spaceBroker.assertNativeLaunchAllowed(agentThreadId(threadId));
        const result = yield* timedComputerLeg(
          "dispatch",
          this.backend.launchApp(app, args, options),
        );
        const owner = agentThreadId(threadId);
        if (
          result.focusChangedDuringLaunch === true &&
          owner &&
          (yield* desktopDeliveryMode) !== "foreground"
        ) {
          const state = this.threadRuntime(owner);
          state.inputPause = {
            ...(result.window ? { windowId: result.window.id } : {}),
            ...(result.pid !== undefined ? { pid: result.pid } : {}),
            message:
              "The app changed desktop focus while launching. The launch already happened; do not replay it. Observe the app's exact window before continuing background input.",
          };
          this.publishCached(owner);
        }
        this.emitAction(threadId, "computer_launch_app");
        if (!result.window && result.windowStatus !== "no_usable_window" && waitForWindowMs > 0) {
          const checkInputReady = this.backend.checkInputReady?.bind(this.backend);
          // Stop interrupts the wait; a failed or hung probe already reads as
          // `input_unavailable` inside `waitForWindow`.
          const readiness = yield* waitForWindow(this.readWindows(), app, waitForWindowMs, {
            ...(result.pid !== undefined ? { pid: result.pid } : {}),
            ...(checkInputReady ? { checkInputReady } : {}),
          });
          yield* assertDesktopOperationActive;
          return { ...result, ...readiness };
        }
        return {
          ...result,
          windowStatus: result.windowStatus ?? (result.window ? "ready" : "not_checked"),
        };
      }),
    );
  }

  listApps(): Effect.Effect<ComputerListAppsResult, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      this.engageBackend();
      const listApps = this.backend.listApps?.bind(this.backend);
      if (!listApps) {
        return yield* new ComputerBackendError({
          message: "This backend cannot enumerate applications.",
        });
      }
      const [availability, apps] = yield* Effect.all([this.backend.availability(), listApps()], {
        concurrency: "unbounded",
      });
      return { computerId: this.computerId, apps, availability };
    });
  }

  /**
   * The admission half every window-grain mutation shares once the exact
   * window row is in hand: owning-app denylist backstop, then the window
   * input check, then once-per-app consent — in that order, before any dispatch.
   * `target.appName ?? windowId` is the consent key a nameless window falls
   * back to, matching the pre-queue resolution the tool layer makes.
   */
  private admitWindowTarget(
    threadId: string | undefined,
    target: ComputerWindow,
  ): Effect.Effect<void, ComputerOperationError> {
    return this.assertDrivenAppAllowed(target.appName ?? target.id).pipe(
      Effect.andThen(this.assertWindowInputAllowedWindow(threadId, target)),
      Effect.andThen(this.assertAppConsented(threadId, target.appName ?? target.id)),
    );
  }

  /**
   * The exact-window resolution the window-grain mutations run identically:
   * a fresh listing proves the id still names a live window, then the shared
   * admission gate runs.
   */
  private resolveWindowTarget(
    threadId: string | undefined,
    windowId: string,
  ): Effect.Effect<ComputerWindow, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      const windows = yield* timedComputerLeg("resolve", this.readWindows());
      const target = windows.find((candidate) => candidate.id === windowId);
      if (!target) return yield* windowNotFoundError(windowId);
      yield* this.admitWindowTarget(threadId, target);
      return target;
    });
  }

  setWindowFrame(
    threadId: string | undefined,
    windowId: string,
    frame: ComputerRect,
  ): Effect.Effect<ComputerActionResult, ComputerOperationError> {
    return this.withBackgroundProcessControl(
      threadId,
      windowId,
      Effect.gen({ self: this }, function* () {
        const setter = this.backend.setWindowFrame?.bind(this.backend);
        if (!setter) {
          return yield* new ComputerBackendError({
            message: "This backend cannot move or resize windows.",
          });
        }
        const target = yield* this.resolveWindowTarget(threadId, windowId);
        if (target.pid !== undefined) {
          yield* this.assertSpaceAppMutationAllowed(threadId, target.pid);
        }
        const result = yield* timedComputerLeg("dispatch", setter(windowId, frame));
        return yield* this.actionResult(
          threadId,
          "computer_set_window_frame",
          undefined,
          result,
          windowId,
        );
      }),
    );
  }

  /**
   * Invoke a menu-bar path on the app the target names: one exact window
   * (validated against a fresh listing, with the owning app's consent and
   * denylist gates), or the application-level menu bar of a running app/pid,
   * which also works for an app without windows. Native menu execution may
   * activate the app, so both routes require the same visible-use
   * authorization and restoration as other foreground actions.
   */
  invokeMenu(
    threadId: string | undefined,
    target: ComputerMenuTarget,
    path: readonly string[],
    authorization?: ComputerForegroundAuthorization,
  ): Effect.Effect<ComputerActionResult & Partial<ForegroundRestoreInfo>, ComputerOperationError> {
    return this.withForegroundRestore(
      threadId,
      withDesktopDeliveryMode(
        "foreground",
        Effect.gen({ self: this }, function* () {
          const invoke = this.backend.invokeMenu?.bind(this.backend);
          if (!invoke) {
            return yield* new ComputerBackendError({
              message: "This backend cannot invoke menu items.",
            });
          }
          if ("windowId" in target) {
            const window = yield* this.resolveWindowTarget(threadId, target.windowId);
            if (window.pid !== undefined) {
              yield* this.assertSpaceAppMutationAllowed(threadId, window.pid);
            }
            const result = yield* timedComputerLeg(
              "dispatch",
              invoke({ windowId: target.windowId }, path),
            );
            return yield* this.actionResult(
              threadId,
              "computer_invoke_menu",
              undefined,
              result,
              target.windowId,
            );
          }
          // Application-level: the denylist keys on the app this target
          // provably names, the same split set_app_visibility makes.
          const resolved = yield* timedComputerLeg("resolve", this.resolveMenuAppTarget(target));
          const consentKey = "app" in target ? target.app : (resolved.name ?? `pid ${target.pid}`);
          yield* this.assertDrivenAppAllowed(consentKey);
          if (agentThreadId(threadId) !== undefined) {
            const denied = yield* this.deniedMatchForPid(resolved.pid, resolved.name);
            if (denied) return yield* new ComputerDenylistError(denied.app, denied.matched);
          }
          yield* this.assertSpaceAppMutationAllowed(threadId, resolved.pid);
          yield* this.assertAppConsented(threadId, resolved.name ?? consentKey);
          const result = yield* timedComputerLeg("dispatch", invoke({ pid: resolved.pid }, path));
          return yield* this.actionResult(threadId, "computer_invoke_menu", undefined, result);
        }),
      ),
      authorization,
    );
  }

  /**
   * The live process an application-level menu target names. An `app` is
   * resolved through the same running-app inventory the consent path
   * consults — exact name or bundle id, case-insensitive — and refuses when
   * nothing matches; a `pid` is passed through with whatever name the
   * inventory has for it, because an unknown pid is the driver's refusal to
   * make.
   */
  private resolveMenuAppTarget(
    target: Exclude<ComputerMenuTarget, { readonly windowId: string }>,
  ): Effect.Effect<{ readonly pid: number; readonly name?: string }, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      const listApps = this.backend.listApps?.bind(this.backend);
      if (listApps === undefined) {
        return yield* new ComputerBackendError({
          message:
            "This backend cannot enumerate applications, so a menu target has to name an exact window.",
        });
      }
      if ("pid" in target) {
        // The tool layer already refuses a malformed pid; this is the direct
        // caller's backstop.
        if (!Number.isSafeInteger(target.pid) || target.pid <= 0) {
          return yield* new ComputerTargetError({
            code: "computer_target_invalid",
            message: `"pid" must be a positive integer; got ${String(target.pid)}.`,
          });
        }
        const owner = (yield* listApps()).find((app) => app.pid === target.pid && app.running);
        return { pid: target.pid, ...(owner !== undefined ? { name: owner.name } : {}) };
      }
      const spelling = target.app.trim();
      const owner = (yield* listApps()).find(
        (app) =>
          app.running &&
          (app.name.trim().toLowerCase() === spelling.toLowerCase() ||
            (app.bundleId !== undefined && app.bundleId.toLowerCase() === spelling.toLowerCase())),
      );
      if (owner === undefined) return yield* menuAppNotFoundError(spelling);
      return { pid: owner.pid, name: owner.name };
    });
  }

  /**
   * Minimize or restore the exact window without activating it — the
   * window-grain explicit visibility control. Same lease, window-existence
   * proof, and owning-app consent as a frame move.
   */
  setWindowMinimized(
    threadId: string | undefined,
    windowId: string,
    minimized: boolean,
  ): Effect.Effect<ComputerActionResult, ComputerOperationError> {
    return this.withBackgroundProcessControl(
      threadId,
      windowId,
      Effect.gen({ self: this }, function* () {
        const setter = this.backend.setWindowMinimized?.bind(this.backend);
        if (!setter) {
          return yield* new ComputerBackendError({
            message: "This backend cannot minimize or restore windows.",
          });
        }
        const target = yield* this.resolveWindowTarget(threadId, windowId);
        if (target.pid !== undefined) {
          yield* this.assertSpaceAppMutationAllowed(threadId, target.pid);
        }
        const result = yield* timedComputerLeg("dispatch", setter(windowId, minimized));
        return yield* this.actionResult(
          threadId,
          "computer_set_window_minimized",
          undefined,
          result,
          windowId,
        );
      }),
    );
  }

  /**
   * Hide or unhide a running app by pid — the app-grain explicit visibility
   * control. Consent keys on what the pid resolves to: the app's name from the
   * process list when it can be resolved, else a stable pid key.
   */
  setAppVisibility(
    threadId: string | undefined,
    pid: number,
    hidden: boolean,
  ): Effect.Effect<ComputerActionResult & { readonly note?: string }, ComputerOperationError> {
    return this.withDesktopControl(
      threadId,
      Effect.gen({ self: this }, function* () {
        const setter = this.backend.setAppVisibility?.bind(this.backend);
        if (!setter) {
          return yield* new ComputerBackendError({
            message: "This backend cannot hide or unhide applications.",
          });
        }
        const listApps = this.backend.listApps?.bind(this.backend);
        const named = yield* timedComputerLeg(
          "resolve",
          listApps === undefined
            ? Effect.succeed(undefined)
            : listApps().pipe(
                Effect.map((apps) => apps.find((app) => app.pid === pid && app.running)?.name),
                Effect.orElseSucceed(() => undefined),
              ),
        );
        yield* this.assertDrivenAppAllowed(named ?? `pid ${pid}`);
        if (agentThreadId(threadId) !== undefined) {
          const denied = yield* this.deniedMatchForPid(pid, named);
          if (denied) return yield* new ComputerDenylistError(denied.app, denied.matched);
        }
        yield* this.assertSpaceAppMutationAllowed(threadId, pid);
        yield* this.assertAppConsented(threadId, named ?? `pid ${pid}`);
        const result = yield* timedComputerLeg("dispatch", setter(pid, hidden));
        const base = yield* this.actionResult(
          threadId,
          "computer_set_app_visibility",
          undefined,
          result,
        );
        // An unhide on an app with no windows shows nothing, and a bare
        // "confirmed" would read as "there it is". The last window listing is
        // the cheap evidence; an absent listing is not evidence, so it earns
        // no note.
        if (hidden || this.lastKnownWindowIds === undefined) return base;
        if ([...this.lastKnownWindows.values()].some((window) => window.pid === pid)) return base;
        return {
          ...base,
          note:
            "This app has no window in the last desktop listing, so the unhide had nothing to show. " +
            "Create a window with the app-level computer_invoke_menu (name the app or pid, e.g. " +
            '["File", "New Window"]), or bind the driver-owned headless browser with ' +
            "computer_browser_prepare and computer_browser_state.",
        };
      }),
    );
  }

  /**
   * The gate every window-scoped read passes identically: the exact id must
   * still name a live window, and a denylisted surface refuses before any of
   * its content is read — state, tree, zoom or cursor alike.
   */
  private assertScopedWindowReadable(
    windowId: string,
  ): Effect.Effect<void, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      const windows = yield* this.readWindows();
      if (!windows.some((candidate) => candidate.id === windowId)) {
        return yield* windowNotFoundError(windowId);
      }
      yield* this.assertWindowContentAllowed(windowId);
    });
  }

  verifyState(
    windowId: string,
    expect: readonly Record<string, unknown>[],
  ): Effect.Effect<ComputerVerifyStateResult, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      this.engageBackend();
      const verify = this.backend.verifyState?.bind(this.backend);
      if (!verify) {
        return yield* new ComputerBackendError({
          message: "This backend cannot verify window state.",
        });
      }
      yield* this.assertScopedWindowReadable(windowId);
      return yield* verify(windowId, expect);
    });
  }

  zoomWindow(
    windowId: string,
    region: ComputerRect,
  ): Effect.Effect<ComputerZoomResult, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      this.engageBackend();
      const zoom = this.backend.zoomWindow?.bind(this.backend);
      if (!zoom) {
        return yield* new ComputerBackendError({
          message: "This backend cannot capture zoomed regions.",
        });
      }
      yield* this.assertScopedWindowReadable(windowId);
      return yield* zoom(windowId, region);
    });
  }

  killApp(
    threadId: string | undefined,
    windowId: string,
  ): Effect.Effect<ComputerActionResult, ComputerOperationError> {
    return this.withBackgroundProcessControl(
      threadId,
      windowId,
      Effect.gen({ self: this }, function* () {
        const kill = this.backend.killApp?.bind(this.backend);
        if (!kill) {
          return yield* new ComputerBackendError({
            message: "This backend cannot terminate applications.",
          });
        }
        // The pid gate runs ahead of admission, as it always has: a window
        // without one reports not-found rather than prompting consent first.
        const windows = yield* timedComputerLeg("resolve", this.readWindows());
        const target = windows.find((candidate) => candidate.id === windowId);
        if (!target?.pid) return yield* windowNotFoundError(windowId);
        const pid = target.pid;
        yield* this.admitWindowTarget(threadId, target);
        yield* this.assertSpaceAppMutationAllowed(threadId, pid);
        const result = yield* timedComputerLeg("dispatch", kill(pid));
        return yield* this.actionResult(threadId, "computer_kill_app", undefined, result, windowId);
      }),
    );
  }

  /**
   * The driver's fast desktop inventory — running apps and on-screen
   * windows — read-only end to end. `windowId` scopes the snapshot to the app
   * that owns that exact window, so it is validated against a fresh window
   * read the same way a targeted perception call is.
   */
  getAccessibilityTree(
    windowId?: string,
  ): Effect.Effect<ComputerAccessibilityTreeResult, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      this.engageBackend();
      const read = this.backend.getAccessibilityTree?.bind(this.backend);
      if (!read) {
        return yield* new ComputerBackendError({
          message: "This backend cannot read the desktop inventory.",
        });
      }
      if (windowId !== undefined) yield* this.assertScopedWindowReadable(windowId);
      const [availability, snapshot] = yield* Effect.all(
        [this.backend.availability(), read(windowId)],
        { concurrency: "unbounded" },
      );
      return {
        computerId: this.computerId,
        ...snapshot,
        ...(windowId !== undefined ? { windowId } : {}),
        availability,
      };
    });
  }

  /**
   * Where the human's pointer sits, in desktop points — a pure read that
   * never takes the control lease or touches the pointer. `windowId`, when
   * given, must still exist, and the answer reports whether the point lies
   * inside its bounds.
   */
  getCursorPosition(
    windowId?: string,
  ): Effect.Effect<ComputerCursorPosition, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      this.engageBackend();
      const read = this.backend.getCursorPosition?.bind(this.backend);
      if (!read) {
        return yield* new ComputerBackendError({
          message: "This backend cannot read the cursor position.",
        });
      }
      if (windowId !== undefined) yield* this.assertScopedWindowReadable(windowId);
      const [availability, point] = yield* Effect.all(
        [this.backend.availability(), read(windowId)],
        { concurrency: "unbounded" },
      );
      return { computerId: this.computerId, ...point, availability };
    });
  }

  getThreadState(threadId: string): Effect.Effect<ThreadComputerState> {
    return Effect.gen({ self: this }, function* () {
      // Registering a record is what seeds the panel — but a suspended thread
      // is mid-removal, and recreating its record would resurrect it.
      const state = this.suspendedThreads.has(threadId)
        ? (this.threads.get(threadId) ?? this.newThreadRuntime())
        : this.threadRuntime(threadId);
      yield* this.refreshPhysicalState();
      return (yield* this.publish(threadId)) ?? this.threadSnapshot(threadId, state);
    });
  }

  /**
   * A human clicks the live pane in desktop coordinates. Resolve its current
   * topmost window once, then keep that identity through capture and injection.
   */
  withUserPointTarget<A, E>(
    point: ComputerPoint,
    action: (target: ComputerTarget) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | ComputerOperationError> {
    return Effect.andThen(
      assertDesktopOperationAdmission,
      this.operations.run(
        Effect.gen({ self: this }, function* () {
          if (this.agentDialect !== "macos") return yield* action(point);
          this.engageBackend();
          const window = topmostWindowAtPoint(yield* this.readWindows(), point);
          if (!window) {
            return yield* new ComputerTargetError({
              code: "computer_target_not_found",
              message: "No exact window is available at this point.",
            });
          }
          const image = yield* this.backend.captureScreenshot({
            kind: "window",
            windowId: window.id,
          });
          return yield* action({
            ...point,
            windowId: window.id,
            observedWindowBounds: image.region,
          } as ComputerTarget);
        }),
      ),
    );
  }

  click(
    threadId: string | undefined,
    target: ComputerTarget,
    modifiers?: readonly ComputerInputModifier[],
    gesture?: ComputerClickGesture,
  ): Effect.Effect<ComputerActionResult, ComputerOperationError> {
    return this.pointerClick(threadId, target, modifiers, gesture);
  }

  doubleClick(
    threadId: string | undefined,
    target: ComputerTarget,
    modifiers?: readonly ComputerInputModifier[],
  ): Effect.Effect<ComputerActionResult, ComputerOperationError> {
    return this.click(threadId, target, modifiers, { count: 2 });
  }

  tripleClick(
    threadId: string | undefined,
    target: ComputerTarget,
    modifiers?: readonly ComputerInputModifier[],
  ): Effect.Effect<ComputerActionResult, ComputerOperationError> {
    return this.click(threadId, target, modifiers, { count: 3 });
  }

  rightClick(
    threadId: string | undefined,
    target: ComputerTarget,
    modifiers?: readonly ComputerInputModifier[],
  ): Effect.Effect<ComputerActionResult, ComputerOperationError> {
    return this.click(threadId, target, modifiers, { button: "right" });
  }

  /**
   * Every click gesture runs one path — they differ only in which backend
   * method carries them, and the gesture picks that up front. The audit and
   * timing label is `computer_click` for all of them.
   */
  private pointerClick(
    threadId: string | undefined,
    target: ComputerTarget,
    modifiers: readonly ComputerInputModifier[] | undefined,
    gesture: ComputerClickGesture | undefined,
  ): Effect.Effect<ComputerActionResult, ComputerOperationError> {
    return this.withBackgroundProcessControl(
      threadId,
      target.windowId,
      Effect.gen({ self: this }, function* () {
        yield* markComputerCall("computer_click");
        const inject = yield* this.clickInjector(gesture);
        const resolved = yield* timedComputerLeg(
          "resolve",
          this.resolvePointTarget(target, threadId),
        );
        yield* timedComputerLeg("resolve", this.prepareResolvedTarget(resolved, threadId));
        const semantic = resolved.semantic;
        if (
          (gesture?.button ?? "left") === "left" &&
          (gesture?.count ?? 1) === 1 &&
          !modifiers?.length &&
          semantic !== undefined &&
          // The token fast path runs whenever the backend advertises AXPress
          // for the target: a live token is the gate.
          this.backend.supportsAction?.(semantic, "AXPress")
        ) {
          yield* assertDesktopOperationActive;
          // Select one actuator before dispatch. An uncertain AX press must never
          // fall through to a coordinate click (toggles could run twice).
          const nativeAction = this.backend.agentDialect === "macos" ? "AXPress" : "press";
          const result = yield* timedComputerLeg(
            "dispatch",
            this.backend.performAction(semantic, nativeAction),
          );
          return yield* this.actionResult(
            threadId,
            "computer_click",
            resolved.point,
            result,
            resolved.windowId,
          );
        }
        yield* this.assertTargetCanUseCoordinates(target);
        const result = yield* this.injectScoped(
          "computer_click",
          resolved,
          inject(resolved.point, resolved.windowId, modifiers),
        );
        return yield* this.actionResult(
          threadId,
          "computer_click",
          resolved.point,
          result,
          resolved.windowId,
        );
      }),
    );
  }

  /**
   * The backend call behind one click gesture, refused up front when the
   * driver exposes no such path: a left click repeats up to three times and
   * a right click exists only once — every other combination is a refusal
   * before any target resolution, never an approximation. Three separate
   * clicks are three carets, not a line selection, so a missing triple click
   * is a refusal too.
   */
  private clickInjector(
    gesture: ComputerClickGesture | undefined,
  ): Effect.Effect<
    (
      point: ComputerPoint,
      windowId: string | undefined,
      modifiers: readonly ComputerInputModifier[] | undefined,
    ) => Effect.Effect<ComputerBackendActionResult | void, ComputerOperationError>,
    ComputerBackendError
  > {
    return Effect.suspend(() => {
      const backend = this.backend;
      const button = gesture?.button ?? "left";
      const count = gesture?.count ?? 1;
      if (button === "left") {
        if (count === 1) {
          return Effect.succeed((point, windowId, modifiers) =>
            backend.click(point, windowId, modifiers),
          );
        }
        if (count === 2) {
          return Effect.succeed((point, windowId, modifiers) =>
            backend.doubleClick(point, windowId, modifiers),
          );
        }
        const tripleClick = backend.tripleClick;
        if (!tripleClick) return Effect.fail(tripleClickUnsupportedError());
        return Effect.succeed((point, windowId, modifiers) =>
          tripleClick.call(backend, point, windowId, modifiers),
        );
      }
      if (button === "right" && count === 1) {
        return Effect.succeed((point, windowId, modifiers) =>
          backend.rightClick(point, windowId, modifiers),
        );
      }
      return Effect.fail(clickGestureUnsupportedError(button, count));
    });
  }

  /**
   * Bring the target into view and aim the agent's keyboard at it.
   *
   * Never-raise default: without the task's explicit visible-use
   * authorization this refuses before any raise is dispatched. See
   * {@link assertForegroundAllowed}.
   */
  activateWindow(
    threadId: string | undefined,
    windowId: string,
    authorization?: ComputerForegroundAuthorization,
  ): Effect.Effect<ComputerActionResult, ComputerOperationError> {
    return this.withDesktopControl(
      threadId,
      Effect.gen({ self: this }, function* () {
        yield* markComputerCall("computer_activate_window");
        const raise = this.backend.raiseWindow?.bind(this.backend);
        if (!raise || !this.backendCapabilities.raise) {
          return yield* activationUnsupportedError();
        }
        const target = yield* this.resolveWindowTarget(threadId, windowId);
        if (target.pid !== undefined) {
          yield* this.assertSpaceAppMutationAllowed(threadId, target.pid);
        }
        yield* timedComputerLeg("dispatch", this.raiseAndFocus(raise, windowId));
        return yield* this.actionResult(
          threadId,
          "computer_activate_window",
          undefined,
          undefined,
          windowId,
        );
      }),
      this.assertForegroundAllowed(threadId, authorization),
    );
  }

  /**
   * Raise, then aim the keyboard. Aiming after the raise, never before: a
   * raise that refuses must not leave the keyboard pointed at a window this
   * call just declined to move.
   */
  private raiseAndFocus(
    raise: NonNullable<ComputerBackend["raiseWindow"]>,
    windowId: string,
  ): Effect.Effect<void, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      yield* raise(windowId);
      yield* assertDesktopOperationActive;
      yield* this.backend.focusWindow?.(windowId) ?? Effect.void;
    });
  }

  /**
   * Bring `windowId` forward for one approved use, then put the desktop back
   * the way it was. Called only from the computer_activate_window tool entry,
   * whose approval covers the whole excursion — including the restore, which
   * never prompts a second time.
   *
   * The steps: record the frontmost window id from the existing topmost-first
   * window listing (a listing of only hidden windows records null with a note)
   * → raise and aim via the existing activate path → run the approved input,
   * if one was given → restore the recorded window via the same raise path →
   * re-observe the target with a fresh listing.
   *
   * A restore that fails is still a successful activation, never a silent one:
   * the result carries a note naming the window that was not put back, and the
   * computer.action event carries the same window plus the restore status.
   */
  foregroundWithRestore(
    threadId: string | undefined,
    windowId: string,
    input?: Effect.Effect<unknown, ComputerOperationError>,
    authorization?: ComputerForegroundAuthorization,
  ): Effect.Effect<ComputerActionResult & { readonly note?: string }, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      (yield* currentComputerCall)?.timing?.count("foreground_excursion");
      return yield* this.withDesktopControl(
        threadId,
        Effect.gen({ self: this }, function* () {
          yield* markComputerCall("computer_activate_window");
          const raise = this.backend.raiseWindow?.bind(this.backend);
          if (!raise || !this.backendCapabilities.raise) {
            return yield* activationUnsupportedError();
          }
          const windows = yield* timedComputerLeg("resolve", this.readWindows());
          const target = windows.find((candidate) => candidate.id === windowId);
          if (!target) return yield* windowNotFoundError(windowId);
          const previousId =
            windows.find((candidate) => candidate.visible && !candidate.minimized)?.id ?? null;
          yield* this.assertDrivenAppAllowed(target.appName ?? windowId);
          yield* this.assertWindowInputAllowedWindow(threadId, target);
          if (target.pid !== undefined) {
            yield* this.assertSpaceAppMutationAllowed(threadId, target.pid);
          }
          yield* this.assertAppConsented(threadId, target.appName ?? windowId);
          // The masked-activation shield arms after admission and before the
          // raise: an opt-in that cannot shield refuses here rather than
          // degrading to an unmasked excursion.
          const shieldId = yield* this.engageActivationShield(threadId, target);
          const excursion = Effect.gen({ self: this }, function* () {
            yield* timedComputerLeg("dispatch", this.raiseAndFocus(raise, windowId));
            if (input) {
              // Input that failed after the raise must not leave the desktop
              // rearranged: restore best-effort, then report the input failure.
              yield* Effect.andThen(assertDesktopOperationActive, input).pipe(
                Effect.tapError(() =>
                  previousId !== null && previousId !== windowId
                    ? Effect.andThen(
                        Effect.ignore(raise(previousId)),
                        Effect.ignore(this.backend.focusWindow?.(previousId) ?? Effect.void),
                      )
                    : Effect.void,
                ),
              );
            }
            let restore: ForegroundRestoreInfo;
            let note: string | undefined;
            if (previousId === null) {
              restore = { restoredWindowId: null, restoreStatus: "frontmost-unobservable" };
              note =
                "No frontmost window was observable before activation, so nothing was restored.";
            } else if (previousId === windowId) {
              restore = { restoredWindowId: null, restoreStatus: "already-frontmost" };
            } else {
              const restored = yield* Effect.exit(
                Effect.andThen(assertDesktopOperationActive, this.raiseAndFocus(raise, previousId)),
              );
              if (Exit.isSuccess(restored)) {
                restore = { restoredWindowId: previousId, restoreStatus: "restored" };
              } else {
                restore = { restoredWindowId: previousId, restoreStatus: "restore-missed" };
                note =
                  `Activated window ${JSON.stringify(windowId)} but could not restore the previously ` +
                  `frontmost window ${JSON.stringify(previousId)} to the foreground; the desktop was ` +
                  `left with ${JSON.stringify(windowId)} raised.`;
              }
            }
            // A fresh listing so the next read sees the desktop as it was left.
            // Best effort: the activation already succeeded.
            yield* Effect.ignore(this.readWindows());
            const merged = computerBackendActionResult(
              this.computerId,
              "computer_activate_window",
              { windowId },
            );
            this.emitForegroundRestoreAction(
              threadId,
              merged,
              restore,
              note,
              shieldId !== undefined,
            );
            return note !== undefined ? { ...merged, note } : merged;
          });
          // The shield is the last piece of the excursion to come down: the
          // restore has already landed, so dropping the mask reveals the
          // desktop the way it was left rather than mid-raise.
          return yield* excursion.pipe(
            Effect.ensuring(
              shieldId !== undefined ? this.releaseActivationShield(shieldId) : Effect.void,
            ),
          );
        }),
        this.assertForegroundAllowed(threadId, authorization),
      );
    });
  }

  /**
   * Run `action` (already approved for foreground delivery) and put the
   * desktop back the way it was. Every foreground call is a focus excursion
   * from the human's point of view: a foreground type or click that leaves the
   * agent's target raised has stolen the user's window for the rest of the
   * session. The restore is covered by the same approval as the call it wraps
   * and never prompts a second time.
   *
   * The raise is skipped when nothing changed. Best-effort like the activate
   * path: a missed restore never fails the call that already succeeded — it
   * warns, and the caller's own action event still reports the foreground
   * delivery.
   */
  withForegroundRestore<A>(
    threadId: string | undefined,
    action: Effect.Effect<A, ComputerOperationError>,
    authorization?: ComputerForegroundAuthorization,
  ): Effect.Effect<A, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      (yield* currentComputerCall)?.timing?.count("foreground_excursion");
      return yield* this.withDesktopControl(
        threadId,
        Effect.gen({ self: this }, function* () {
          const before = yield* timedComputerLeg("resolve", this.readWindows());
          const previousId =
            before.find((candidate) => candidate.visible && !candidate.minimized)?.id ?? null;
          const outcome = yield* Effect.exit(action);
          const raise = this.backend.raiseWindow?.bind(this.backend);
          if (previousId !== null && raise && this.backendCapabilities.raise) {
            const after = yield* Effect.option(timedComputerLeg("resolve", this.readWindows()));
            if (Option.isNone(after)) {
              // The post-call read failed, so whether the excursion left the
              // target raised is unknown — the restore cannot run blind, and a
              // possibly stolen frontmost must not pass without a trace.
              yield* Effect.logWarning("[computer] foreground call left focus unverified").pipe(
                Effect.annotateLogs({ previousWindowId: previousId }),
              );
            } else {
              const frontmost =
                after.value.find((candidate) => candidate.visible && !candidate.minimized)?.id ??
                null;
              if (frontmost !== null && frontmost !== previousId) {
                yield* Effect.andThen(
                  assertDesktopOperationActive,
                  this.raiseAndFocus(raise, previousId),
                ).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("[computer] foreground call left focus unrestored").pipe(
                      Effect.annotateLogs({
                        restoredWindowId: previousId,
                        error: errorMessage(error),
                      }),
                    ),
                  ),
                );
              }
            }
          }
          return yield* outcome;
        }),
        Effect.andThen(
          this.assertForegroundAllowed(threadId, authorization),
          this.spaceBroker.assertForegroundAllowed(agentThreadId(threadId)),
        ),
      );
    });
  }

  /**
   * The computer.action event for a foreground excursion: emitAction's payload
   * plus which window was put back and whether that succeeded. The two fields
   * ride as extras (with the note in the schema's message) because the
   * contract's event shape does not name them yet. `masked` records whether
   * the excursion ran under the activation shield — the disclosure trail for
   * a delivery the operator could not watch directly.
   */
  private emitForegroundRestoreAction(
    threadId: string | undefined,
    result: ComputerActionResult,
    restore: ForegroundRestoreInfo,
    note: string | undefined,
    masked: boolean,
  ): void {
    const attributed = agentThreadId(threadId);
    if (attributed) this.surfacePaneForAgent(attributed);
    this.emit({
      type: "computer.action",
      ...(result.windowId ? { windowId: result.windowId } : {}),
      ...(result.delivery ? { delivery: result.delivery } : {}),
      action: "computer_activate_window",
      ok: true,
      ...(attributed ? { threadId: ThreadId.make(attributed) } : {}),
      ...(restore.restoredWindowId !== null ? { restoredWindowId: restore.restoredWindowId } : {}),
      restoreStatus: restore.restoreStatus,
      ...(masked ? { masked: true } : {}),
      ...(note !== undefined
        ? { message: clampComputerMessage(note, "The foreground window could not be restored.") }
        : {}),
    } as ComputerEvent);
  }

  /**
   * The masked-activation decision for one resolved target. Engages the
   * Pathway-owned shield only when the canary flag is armed, the backend
   * speaks the macOS dialect, and the target's owning app is on the
   * `PATHWAY_CUA_MASKED_APPS` opt-in list — all three, always. Anything less
   * returns `undefined` and the call takes the ordinary visible path.
   *
   * When the opt-in does name the app, the shield becomes mandatory: a
   * backend that cannot show it fails the activation rather than degrading to
   * an unmasked raise. The shield id is minted here — not by the backend — so
   * a lost engage reply still leaves this side holding the release handle.
   */
  private engageActivationShield(
    _threadId: string | undefined,
    target: ComputerWindow,
  ): Effect.Effect<string | undefined, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      if (!cuaMaskedActivationEnabled()) return undefined;
      if (this.agentDialect !== "macos") return undefined;
      const optIn = cuaMaskedActivationOptIn();
      if (optIn.size === 0) return undefined;
      const owner =
        target.pid !== undefined
          ? (yield* this.runningAppsForDenylist()).find((candidate) => candidate.pid === target.pid)
          : undefined;
      if (!maskedActivationOptedIn(optIn, owner?.bundleId)) return undefined;
      const engage = this.backend.engageShield?.bind(this.backend);
      const frame = target.bounds;
      if (!engage || !frame) {
        return yield* new ComputerBackendError({
          message:
            "Masked activation is armed for this app but the activation shield is unavailable; the window was not raised.",
        });
      }
      const appName = target.title?.trim() || target.appName || "this window";
      const label = `Pathway is activating ${appName}`;
      const shieldId = `shield-${(yield* Random.nextIntBetween(0, 0xffffffff)).toString(16).padStart(8, "0")}`;
      return yield* timedComputerLeg(
        "shield",
        engage({ shieldId, windowId: target.id, frame, label }),
      ).pipe(
        // The reply may be the only thing lost — the shield could still be up.
        // The minted id makes that reachable: release it before refusing.
        Effect.tapCause(() => this.releaseActivationShield(shieldId)),
        Effect.mapError((error) =>
          isComputerBackendError(error)
            ? error
            : new ComputerBackendError({
                message: `The activation shield could not be shown, so the window was not raised: ${errorMessage(error)}`,
              }),
        ),
      );
    });
  }

  /**
   * Drop one shield, best-effort and cancellation-immune: releasing is how
   * the excursion ends, so it must still land while the operation that
   * engaged it is being torn down.
   */
  private releaseActivationShield(shieldId: string): Effect.Effect<void> {
    const release = this.backend.releaseShield?.bind(this.backend);
    if (!release) return Effect.void;
    return withoutDesktopCancellation(release(shieldId)).pipe(
      Effect.catch((error) =>
        Effect.logWarning("[computer] activation shield release failed").pipe(
          Effect.annotateLogs({ shieldId, error: errorMessage(error) }),
        ),
      ),
    );
  }

  moveCursor(
    threadId: string | undefined,
    target: ComputerTarget,
  ): Effect.Effect<ComputerActionResult, ComputerOperationError> {
    return Effect.andThen(
      this.assertTargetCanUseCoordinates(target),
      this.withBackgroundProcessControl(
        threadId,
        target.windowId,
        Effect.gen({ self: this }, function* () {
          const resolved = yield* timedComputerLeg(
            "resolve",
            this.resolvePointTarget(target, threadId),
          );
          yield* timedComputerLeg("resolve", this.revealTarget(resolved));
          const result = yield* this.injectScoped(
            "computer_move_cursor",
            resolved,
            this.backend.moveCursor(resolved.point, resolved.windowId),
          );
          return yield* this.actionResult(
            threadId,
            "computer_move_cursor",
            resolved.point,
            result,
            resolved.windowId,
          );
        }),
      ),
    );
  }

  drag(
    threadId: string | undefined,
    from: ComputerTarget,
    to: ComputerTarget,
    durationMs = 250,
  ): Effect.Effect<ComputerActionResult, ComputerOperationError> {
    return Effect.andThen(
      Effect.andThen(
        this.assertTargetCanUseCoordinates(from),
        this.assertTargetCanUseCoordinates(to),
      ),
      this.withDesktopControl(
        threadId,
        Effect.gen({ self: this }, function* () {
          const [resolvedFrom, resolvedTo] = yield* timedComputerLeg(
            "resolve",
            Effect.all(
              [this.resolvePointTarget(from, threadId), this.resolvePointTarget(to, threadId)],
              { concurrency: "unbounded" },
            ),
          );
          // The drag is grabbed by the window it starts in, so that window is
          // the one raised and focused; the destination only scopes it when the
          // origin names no window at all.
          const grabbed = resolvedFrom.windowId ? resolvedFrom : resolvedTo;
          yield* timedComputerLeg("resolve", this.prepareResolvedTarget(grabbed, threadId));
          const result = yield* this.injectScoped(
            "computer_drag",
            grabbed,
            this.backend.drag(
              resolvedFrom.point,
              resolvedTo.point,
              durationMs,
              resolvedFrom.windowId,
            ),
          );
          return yield* this.actionResult(
            threadId,
            "computer_drag",
            resolvedTo.point,
            result,
            resolvedTo.windowId ?? resolvedFrom.windowId,
          );
        }),
      ),
    );
  }

  /**
   * The raw gesture: the deltas given are the deltas injected.
   *
   * This is the pane's path, carrying a human's own wheel events. Their gesture
   * must never be re-geared — they are watching the result and closing the loop
   * themselves. Agent scrolls go through `scrollCalibrated` instead.
   */
  scroll(
    threadId: string | undefined,
    target: ComputerTarget | null,
    deltaX: number,
    deltaY: number,
  ): Effect.Effect<ComputerActionResult, ComputerOperationError> {
    return this.withBackgroundProcessControl(
      threadId,
      target?.windowId,
      Effect.gen({ self: this }, function* () {
        const resolved = yield* timedComputerLeg(
          "resolve",
          this.prepareScrollTarget(target, threadId),
        );
        const result = yield* this.injectScroll(resolved, deltaX, deltaY, undefined);
        return yield* this.actionResult(
          threadId,
          "computer_scroll",
          resolved?.point,
          result,
          resolved?.windowId,
        );
      }),
    );
  }

  /**
   * Scroll, then check what the window did with it — the agent's path.
   *
   * A scroll request is in logical pixels, but no client is obliged to treat it
   * that way: Qt honors the pixel deltas exactly while GTK-hosted browsers
   * convert them to their own scroll units and travel several times as far.
   * Nothing reports that conversion, so the distance is measured from
   * before/after captures of the affected window, returned to the caller as
   * `scroll.traveledY`, and remembered per window so the next request to it is
   * pre-divided by what was learned.
   *
   * Measurement is best-effort throughout: a capture that fails, a window that
   * cannot be identified, or a correlation that will not commit leaves the
   * scroll delivered and simply unmeasured. The after-capture doubles as the
   * caller's observation, so the closed loop costs no extra screenshot.
   *
   * A large request into a window nobody has measured is split: a small probe
   * goes first, its travel is measured and learned, and the remainder — the
   * request minus what the probe already covered — is delivered pre-divided by
   * the fresh gearing. Without the split, the first scroll into a 7x browser
   * travels so far that the before and after captures share no content, the
   * correlation refuses, and nothing is ever learned.
   */
  scrollCalibrated(
    threadId: string | undefined,
    target: ComputerTarget | null,
    deltaX: number,
    deltaY: number,
    options: {
      readonly observe: boolean;
      /** Held down for every injected leg of this scroll, released after each. */
      readonly modifiers?: readonly ComputerInputModifier[];
    },
  ): Effect.Effect<
    { readonly result: ComputerActionResult; readonly observation?: ComputerActionObservation },
    ComputerOperationError
  > {
    return this.withBackgroundProcessControl(
      threadId,
      target?.windowId,
      Effect.gen({ self: this }, function* () {
        // An untargeted scroll routes to whatever sits under the agent's cursor
        // once the pinned focus is cleared — but preparing the target clears
        // that focus, and it was the only fallback naming the observed window.
        // Read the candidates that will not survive the clear first.
        const attributed = agentThreadId(threadId);
        const cursorPoint =
          target !== null
            ? undefined
            : attributed
              ? this.threads.get(attributed)?.cursor
              : undefined;
        const preClearFocusId = target !== null ? undefined : yield* this.agentFocusWindowId();
        const resolved = yield* timedComputerLeg(
          "resolve",
          this.prepareScrollTarget(target, threadId),
        );
        // The window the gesture lands in, by the ladder `captureActionScreenshot`
        // already climbs. A scroll that lands somewhere else measures no travel
        // and so teaches this window nothing, which is the right outcome for a
        // guess.
        const observedWindowId =
          resolved?.windowId ??
          (resolved?.point ? yield* this.windowIdAtActionPoint(resolved.point) : undefined) ??
          (cursorPoint ? yield* this.windowIdAtActionPoint(cursorPoint) : undefined) ??
          preClearFocusId ??
          (yield* this.agentFocusWindowId());
        const before = !options.observe
          ? undefined
          : yield* this.captureForMeasurement(observedWindowId);

        // Gearing keys are route-scoped: an AX scroll-bar press and a wheel
        // gesture move the same window different distances for one request, so
        // the two never share a learned ratio. The app key is the durable
        // fallback — a window nobody has measured inherits what its app
        // already taught an earlier window.
        const observedWindow =
          observedWindowId === undefined
            ? undefined
            : (yield* this.readWindows()).find((window) => window.id === observedWindowId);
        const appKey =
          observedWindow?.appName ??
          (observedWindow?.pid !== undefined ? `pid:${observedWindow.pid}` : undefined);
        const windowKey = (route: string) =>
          observedWindowId === undefined ? undefined : `${observedWindowId}|${route}`;
        const durableKey = (route: string) =>
          appKey === undefined ? undefined : `${appKey}|${route}`;
        // The AX rung only runs for an unmodified vertical scroll at an element
        // target; every other request is a wheel gesture.
        const plannedRoute = (legDeltaX: number) =>
          resolved?.semantic !== undefined && legDeltaX === 0 && !options.modifiers?.length
            ? "ax"
            : "wheel";
        // The backend reports which rung actually ran; trust it over the plan.
        const legRoute = (leg: ComputerBackendActionResult | void, planned: string) =>
          leg?.deliveryPath?.startsWith("cua-ax") === true
            ? "ax"
            : leg?.deliveryPath !== undefined
              ? "wheel"
              : planned;
        const measured = (route: string) =>
          this.scrollGearing.has(windowKey(route)) ||
          this.scrollGearingFile.get(durableKey(route)) !== undefined;
        const plan = (route: string, requested: number) =>
          this.scrollGearing.plan(
            windowKey(route),
            requested,
            this.scrollGearingFile.get(durableKey(route)),
          );

        let injectedX = 0;
        let injectedY = 0;
        let after: ComputerCapturedWindow | undefined;
        let traveledY: number | undefined;
        let result: ComputerBackendActionResult | void;
        const routes: string[] = [];
        let reportedGearing: number | undefined;

        if (
          before !== undefined &&
          observedWindowId !== undefined &&
          !measured(plannedRoute(0)) &&
          Math.abs(deltaY) > SCROLL_PROBE_TRIGGER_PX
        ) {
          const probe = Math.sign(deltaY) * SCROLL_PROBE_PX;
          const probeResult = yield* this.injectScroll(resolved, 0, probe, options.modifiers);
          result = probeResult;
          // The backend's own account of what went in — macOS quantizes the
          // leg to whole notches — is what the correlation learns from.
          const probeInjected = probeResult?.scrollDelta?.deltaY ?? probe;
          injectedY += probeInjected;
          const probeRoute = legRoute(probeResult, plannedRoute(0));
          routes.push(probeRoute);
          const probeLeg = yield* this.settleAndMeasure(
            observedWindowId,
            before,
            probeInjected,
            windowKey(probeRoute),
            durableKey(probeRoute),
          );
          after = probeLeg.capture;
          // What the probe already delivered comes off the ask. An unmeasured
          // or wrong-way measurement deducts only the probe's own request.
          const covered =
            probeLeg.traveled !== undefined && Math.sign(probeLeg.traveled) === Math.sign(deltaY)
              ? probeLeg.traveled
              : probeInjected;
          const remainder = Math.abs(covered) >= Math.abs(deltaY) ? 0 : deltaY - covered;
          // One gearing per window drives both axes: a toolkit's unit
          // conversion is a property of how it reads scroll events, and only
          // the vertical travel is measurable from a row correlation.
          const legX = plan(plannedRoute(deltaX), deltaX);
          const legY = plan(plannedRoute(deltaX), remainder);
          if (legX !== 0 || legY !== 0) {
            const remainderResult = yield* this.injectScroll(
              resolved,
              legX,
              legY,
              options.modifiers,
            );
            result = remainderResult;
            injectedX += remainderResult?.scrollDelta?.deltaX ?? legX;
            injectedY += remainderResult?.scrollDelta?.deltaY ?? legY;
            const remainderRoute = legRoute(remainderResult, plannedRoute(deltaX));
            routes.push(remainderRoute);
            if (after) {
              const remainderLeg = yield* this.settleAndMeasure(
                observedWindowId,
                after,
                remainderResult?.scrollDelta?.deltaY ?? legY,
                windowKey(remainderRoute),
                durableKey(remainderRoute),
              );
              after = remainderLeg.capture ?? after;
              traveledY =
                probeLeg.traveled !== undefined && remainderLeg.traveled !== undefined
                  ? probeLeg.traveled + remainderLeg.traveled
                  : undefined;
            }
          } else {
            traveledY = probeLeg.traveled;
          }
        } else {
          const route = plannedRoute(deltaX);
          injectedX = plan(route, deltaX);
          injectedY = plan(route, deltaY);
          result = yield* this.injectScroll(resolved, injectedX, injectedY, options.modifiers);
          injectedX = result?.scrollDelta?.deltaX ?? injectedX;
          injectedY = result?.scrollDelta?.deltaY ?? injectedY;
          const actualRoute = legRoute(result, route);
          routes.push(actualRoute);
          if (before) {
            const leg = yield* this.settleAndMeasure(
              observedWindowId,
              before,
              injectedY,
              windowKey(actualRoute),
              durableKey(actualRoute),
            );
            after = leg.capture;
            traveledY = leg.traveled;
          }
        }
        // Report the effective gearing whenever a window was observed: its own
        // learned ratio, else the app's durable fallback, else pixel-true 1.
        const reportRoute = routes.at(-1);
        if (observedWindowId !== undefined && reportRoute !== undefined) {
          const key = windowKey(reportRoute);
          reportedGearing = this.scrollGearing.has(key)
            ? this.scrollGearing.gearing(key)
            : (this.scrollGearingFile.get(durableKey(reportRoute)) ?? 1);
        }

        const base = yield* this.actionResult(
          threadId,
          "computer_scroll",
          resolved?.point,
          result,
          resolved?.windowId,
        );
        return {
          result: {
            ...base,
            scroll: {
              requested: { deltaX, deltaY },
              injected: { deltaX: round2(injectedX), deltaY: round2(injectedY) },
              ...(traveledY === undefined ? {} : { traveledY: round2(traveledY) }),
              ...(reportedGearing === undefined ? {} : { gearing: round2(reportedGearing) }),
              ...(routes.length === 0 ? {} : { routes }),
            },
          },
          ...(after ? { observation: after } : {}),
        };
      }),
    );
  }

  private prepareScrollTarget(
    target: ComputerTarget | null,
    threadId: string | undefined,
  ): Effect.Effect<ResolvedPointTarget | null, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      const resolved = target ? yield* this.resolveScrollPointTarget(target, threadId) : null;
      yield* this.prepareResolvedTarget(resolved ?? undefined, threadId);
      return resolved;
    });
  }

  /**
   * Scroll accepts one control-less target the semantic resolver refuses: a
   * bare window id, meaning "scroll this window". It resolves to the window's
   * own point — its node in the accessibility tree when it has one, else the
   * centre of its reported bounds — rather than entering label matching,
   * where a query naming no control matches everything in scope.
   */
  private resolveScrollPointTarget(
    target: ComputerTarget,
    threadId: string | undefined,
  ): Effect.Effect<ResolvedPointTarget, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      const windowId = target.windowId;
      if (
        windowId === undefined ||
        target.x !== undefined ||
        target.y !== undefined ||
        hasLabelFields(target)
      ) {
        return yield* this.resolvePointTarget(target, threadId);
      }
      yield* this.assertWindowInputAllowed(threadId, windowId);
      const state = yield* this.backend.getState({ includeTree: false });
      const match = state.root
        ? yield* resolveComputerWindowTarget(state.root, windowId)
        : undefined;
      if (match) return { point: match.point, windowId };
      const window =
        (yield* this.readWindows()).find((candidate) => candidate.id === windowId) ??
        this.lastKnownWindows.get(windowId);
      if (!window) return yield* windowNotFoundError(windowId);
      const bounds = window.bounds;
      if (!bounds) {
        return yield* new ComputerTargetError({
          code: "computer_target_offscreen",
          message:
            `This desktop reports no geometry for window ${JSON.stringify(windowId)}, so a scroll ` +
            "point inside it cannot be chosen. Scroll at x/y coordinates instead.",
        });
      }
      return {
        point: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
        windowId,
      };
    });
  }

  private injectScroll(
    resolved: ResolvedPointTarget | null,
    deltaX: number,
    deltaY: number,
    modifiers: readonly ComputerInputModifier[] | undefined,
  ): Effect.Effect<ComputerBackendActionResult | void, ComputerOperationError> {
    return this.injectScoped(
      "computer_scroll",
      resolved ?? {},
      this.backend.scroll(
        resolved?.point ?? null,
        deltaX,
        deltaY,
        resolved?.windowId,
        modifiers,
        resolved?.semantic,
      ),
    );
  }

  /**
   * One injected leg's perception: settle, recapture, measure against `from`,
   * and teach the store what the window did with the injection. A capture or
   * correlation that fails leaves the leg unmeasured, never undelivered.
   *
   * `PATHWAY_CUA_CONDITIONAL_SETTLE` extends to legs whose route already
   * carries a learned gearing, because a learned ratio is a prediction of how
   * far this injection should move the content. The leg is captured before
   * the wait, and a measurement landing on that prediction is itself the
   * settle evidence, so the fixed sleep is waived and counted. Everything else
   * keeps the settle and measures a settled frame against `from`, never
   * against the early frame, whose displacement would only count the
   * animation's tail.
   */
  private settleAndMeasure(
    windowId: string | undefined,
    from: ComputerCapturedWindow,
    injectedY: number,
    windowKey?: string,
    appKey?: string,
  ): Effect.Effect<{ readonly capture?: ComputerCapturedWindow; readonly traveled?: number }> {
    return Effect.gen({ self: this }, function* () {
      if (this.actionSettleMs > 0 && injectedY !== 0 && cuaConditionalSettleEnabled()) {
        const predictedGearing = this.scrollGearing.has(windowKey)
          ? this.scrollGearing.gearing(windowKey)
          : this.scrollGearingFile.get(appKey);
        if (predictedGearing !== undefined) {
          const expectedY = injectedY * predictedGearing;
          const early = yield* this.captureForMeasurement(windowId);
          if (early) {
            const traveled = yield* this.measureLegTravel(
              from.screenshot,
              early.screenshot,
              injectedY,
            );
            if (
              traveled !== undefined &&
              Math.abs(traveled - expectedY) <=
                Math.max(
                  SCROLL_SETTLE_ARRIVAL_MIN_PX,
                  Math.abs(expectedY) * SCROLL_SETTLE_ARRIVAL_TOLERANCE,
                )
            ) {
              this.learnLegTravel(windowKey ?? windowId, appKey, injectedY, traveled);
              (yield* currentComputerCall)?.timing?.count("settle_skipped");
              return { capture: early, traveled };
            }
          }
        }
      }
      if (this.actionSettleMs > 0) {
        yield* timedComputerLeg("settle", this.settleAfterAction(windowId));
      }
      const capture = yield* this.captureForMeasurement(windowId);
      if (!capture) return {};
      const traveled = yield* this.measureLegTravel(from.screenshot, capture.screenshot, injectedY);
      this.learnLegTravel(windowKey ?? windowId, appKey, injectedY, traveled);
      return { capture, ...(traveled === undefined ? {} : { traveled }) };
    });
  }

  /**
   * The travel one capture pair supports, in logical pixels, or nothing the
   * caller cannot trust. A travel opposing the injection is the correlator
   * locking onto the wrong feature — repetitive content aliases — not a page
   * that scrolled backwards.
   */
  private measureLegTravel(
    from: ComputerScreenshot,
    to: ComputerScreenshot,
    injectedY: number,
  ): Effect.Effect<number | undefined> {
    return Effect.map(this.measureTravel(from, to), (measured) =>
      measured !== undefined &&
      measured !== 0 &&
      injectedY !== 0 &&
      Math.sign(measured) !== Math.sign(injectedY)
        ? undefined
        : measured,
    );
  }

  /**
   * Folds one accepted measurement into the gearing stores; the durable app
   * fallback only records samples the hot store took. The file write runs
   * detached: a slow disk must not delay the scroll that taught it.
   */
  private learnLegTravel(
    key: string | undefined,
    appKey: string | undefined,
    injectedY: number,
    traveled: number | undefined,
  ): void {
    if (traveled === undefined || injectedY === 0) return;
    if (this.scrollGearing.learn(key, injectedY, traveled)) {
      this.runFork(this.scrollGearingFile.learn(appKey, injectedY, traveled));
    }
  }

  /** The agent seat's focus target, when it has one; never the human's. */
  private agentFocusWindowId(): Effect.Effect<string | undefined> {
    return this.focusedCapturableWindow(true).pipe(
      Effect.map((window) => window?.id),
      Effect.orElseSucceed(() => undefined),
    );
  }

  /**
   * A capture taken to be measured against another one, and then handed to the
   * caller as the action's observation. Measurement does not register a
   * delivered frame: the before-capture is never shown to anyone.
   *
   * With no window to name it widens to the same workspace capture the
   * observation path would take, which is still comparable to itself even
   * though nothing can be learned from a region that is not one window.
   */
  private captureForMeasurement(
    windowId: string | undefined,
  ): Effect.Effect<ComputerCapturedWindow | undefined> {
    return Effect.suspend(() => {
      if (!this.backendCapabilities.capture) return Effect.succeed(undefined);
      this.engageBackend();
      const capture: Effect.Effect<ComputerCapturedWindow, ComputerOperationError> =
        windowId === undefined
          ? this.captureFocusedWindow(COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION, {
              agentFocusOnly: true,
            })
          : Effect.map(
              this.backend.captureScreenshot({
                kind: "window",
                windowId,
                maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
              }),
              (screenshot) => ({ screenshot, windowId }),
            );
      return timedComputerLeg("observe", capture).pipe(Effect.orElseSucceed(() => undefined));
    });
  }

  /** The decoded capture bytes, cached per screenshot object. */
  private measurementBytes(screenshot: ComputerScreenshot): Uint8Array {
    let bytes = this.screenshotBytes.get(screenshot);
    if (!bytes) {
      bytes = Buffer.from(screenshot.bytesBase64, "base64");
      this.screenshotBytes.set(screenshot, bytes);
    }
    return bytes;
  }

  /**
   * Vertical travel in logical pixels, or nothing when the two captures cannot
   * be compared. Byte equality answers first and for free: pixels that did not
   * change did not move, which is what the end of a page looks like.
   */
  private measureTravel(
    before: ComputerScreenshot,
    after: ComputerScreenshot,
  ): Effect.Effect<number | undefined> {
    return Effect.suspend(() => {
      if (before.bytesBase64 === after.bytesBase64) return Effect.succeed(0);
      // Without a scale on both captures there is no conversion from capture
      // pixels to logical pixels, and two different scales are two different
      // pictures of the window.
      const scale = before.scale;
      if (scale === undefined || scale !== after.scale || scale <= 0) {
        return Effect.succeed(undefined);
      }
      return Effect.map(
        this.measureScrollTravel(this.measurementBytes(before), this.measurementBytes(after)),
        (traveled) => (traveled === undefined ? undefined : traveled / scale),
      );
    });
  }

  typeText(
    threadId: string | undefined,
    text: string,
    windowId?: string,
  ): Effect.Effect<ComputerActionResult, ComputerOperationError> {
    return Effect.suspend(() => {
      if (this.supportsFocusNeutralSemanticText && windowId) {
        // Resolution may fail before anything was sent. A rich editor is often
        // absent from a truncated tree or sits beside other fields; the agent
        // then spelled the text out through computer_press_key, one round trip
        // per character. Send the whole string through the keyboard path once
        // instead: the same exact-window keyboard admission applies, and it
        // lands in the field the app has focused, exactly as those key
        // presses did.
        return this.typeTextAt(threadId, text, { windowId }).pipe(
          Effect.catchIf(
            (error) => isComputerTargetError(error) && error.unresolvedTextControl === true,
            () =>
              this.withBackgroundProcessControl(
                threadId,
                windowId,
                Effect.gen({ self: this }, function* () {
                  const result = yield* this.runKeyboardDispatch(
                    threadId,
                    windowId,
                    this.backend.typeText(text, windowId),
                  );
                  return yield* this.actionResult(
                    threadId,
                    "computer_type_text",
                    undefined,
                    result,
                    windowId,
                  );
                }),
              ),
          ),
        );
      }
      return this.withDesktopControl(
        threadId,
        Effect.gen({ self: this }, function* () {
          const result = yield* this.runKeyboardDispatch(
            threadId,
            windowId,
            this.backend.typeText(text, windowId),
          );
          return yield* this.actionResult(
            threadId,
            "computer_type_text",
            undefined,
            result,
            windowId,
          );
        }),
      );
    });
  }

  typeTextAt(
    threadId: string | undefined,
    text: string,
    target: ComputerTarget,
  ): Effect.Effect<ComputerActionResult, ComputerOperationError> {
    return Effect.suspend(() => {
      if (!this.supportsFocusNeutralSemanticText) {
        return Effect.fail(
          new ComputerBackendError({
            message: "This computer backend cannot guarantee focus-neutral semantic text input.",
          }),
        );
      }
      const windowId = target.windowId;
      if (!windowId) {
        return Effect.fail(
          new ComputerBackendError({
            message: "Focus-neutral text input requires an exact target window.",
          }),
        );
      }
      return this.withBackgroundWindowControl(
        threadId,
        windowId,
        Effect.gen({ self: this }, function* () {
          const resolved = yield* timedComputerLeg(
            "resolve",
            this.resolveSemanticTarget(target, true),
          );
          yield* assertDesktopOperationActive;
          const result = yield* timedComputerLeg(
            "dispatch",
            this.backend.typeText(text, windowId, resolved),
          );
          return yield* this.actionResult(
            threadId,
            "computer_type_text",
            resolved.point,
            result,
            windowId,
          );
        }),
      );
    });
  }

  pressKey(
    threadId: string | undefined,
    key: string,
    windowId?: string,
    target?: ComputerTarget,
  ): Effect.Effect<ComputerActionResult, ComputerOperationError> {
    return this.keyboardAction(threadId, windowId, target, (exactWindow, resolved) =>
      this.backend.pressKey(key, exactWindow, resolved),
    );
  }

  hotkey(
    threadId: string | undefined,
    keys: readonly string[],
    windowId?: string,
    target?: ComputerTarget,
  ): Effect.Effect<ComputerActionResult, ComputerOperationError> {
    // The tool surface folds chords into computer_press_key.
    return this.keyboardAction(threadId, windowId, target, (exactWindow, resolved) =>
      this.backend.hotkey(keys, exactWindow, resolved),
    );
  }

  /** The shared body of `pressKey` and `hotkey`, which differ only in dispatch. */
  private keyboardAction(
    threadId: string | undefined,
    windowId: string | undefined,
    target: ComputerTarget | undefined,
    dispatch: (
      exactWindow: string | undefined,
      resolved: ComputerResolvedTarget | undefined,
    ) => Effect.Effect<ComputerBackendActionResult | void, ComputerOperationError>,
  ): Effect.Effect<ComputerActionResult, ComputerOperationError> {
    return Effect.flatMap(this.keyboardTargetWindow(windowId, target), (exactWindow) =>
      this.withBackgroundProcessControl(
        threadId,
        exactWindow,
        Effect.gen({ self: this }, function* () {
          const resolved = target
            ? yield* this.resolveSemanticTarget(
                { ...target, ...(exactWindow ? { windowId: exactWindow } : {}) },
                true,
              )
            : undefined;
          const result = yield* this.runKeyboardDispatch(
            threadId,
            exactWindow,
            dispatch(exactWindow, resolved),
          );
          return yield* this.actionResult(
            threadId,
            "computer_press_key",
            resolved?.point,
            result,
            exactWindow,
          );
        }),
      ),
    );
  }

  private keyboardTargetWindow(
    windowId: string | undefined,
    target: ComputerTarget | undefined,
  ): Effect.Effect<string | undefined, ComputerTargetError> {
    if (windowId !== undefined && target?.windowId !== undefined && target.windowId !== windowId) {
      return Effect.fail(
        new ComputerTargetError({
          code: "computer_target_invalid",
          message:
            "The keyboard window and element target name different windows; nothing was sent.",
        }),
      );
    }
    return Effect.succeed(windowId ?? target?.windowId);
  }

  /**
   * The clipboard is the system one the human shares, and it is optional on the
   * backend, so a backend without it refuses the call instead of the tool
   * layer discovering a missing method at dispatch time.
   *
   * Reading it takes the lease even though it mutates nothing: the clipboard is
   * one shared slot that the owning thread is mid-way through using, and a read
   * from a second thread is either racing that write or reading its private
   * payload.
   */
  readClipboard(
    threadId: string | undefined,
  ): Effect.Effect<ComputerActionResult, ComputerOperationError> {
    return this.withDesktopControl(
      threadId,
      Effect.gen({ self: this }, function* () {
        const read = this.backend.readClipboard?.bind(this.backend);
        if (!read) return yield* clipboardUnsupportedError();
        const value = yield* timedComputerLeg("dispatch", read());
        // `ComputerActionResult.value` is contract-bounded well below the
        // backend's byte cap, and an oversized read must not slip out through
        // the unvalidated MCP result path.
        if (value.length > COMPUTER_TEXT_MAX_LENGTH) {
          return yield* new ComputerBackendError({
            message: `The desktop clipboard holds ${value.length} characters of text, more than the ${COMPUTER_TEXT_MAX_LENGTH} this tool returns.`,
          });
        }
        return yield* this.actionResult(threadId, "computer_read_clipboard", undefined, { value });
      }),
    );
  }

  writeClipboard(
    threadId: string | undefined,
    text: string,
  ): Effect.Effect<ComputerActionResult, ComputerOperationError> {
    return this.withDesktopControl(
      threadId,
      Effect.gen({ self: this }, function* () {
        const write = this.backend.writeClipboard?.bind(this.backend);
        if (!write) return yield* clipboardUnsupportedError();
        yield* timedComputerLeg("dispatch", write(text));
        // The text is not echoed back on `value`: the caller already has it,
        // and it may be far larger than the contract bound on that field.
        return yield* this.actionResult(threadId, "computer_write_clipboard", undefined, undefined);
      }),
    );
  }

  /**
   * Bulk text entry through the shared clipboard: save what the user had,
   * write the payload, send the paste shortcut, then put their contents back.
   * It still goes through the keyboard-target path, so it lands exactly where
   * computer_type_text would and nowhere else.
   *
   * `clipboardRestored` reports whether the previous contents went back. A
   * clipboard holding non-text content cannot be saved or restored and is
   * replaced; a failed restore is reported rather than silently leaving the
   * pasted text behind.
   */
  paste(
    threadId: string | undefined,
    text: string,
    windowId?: string,
  ): Effect.Effect<
    ComputerActionResult & { readonly clipboardRestored: boolean },
    ComputerOperationError
  > {
    return this.withDesktopControl(
      threadId,
      Effect.gen({ self: this }, function* () {
        const read = this.backend.readClipboard?.bind(this.backend);
        const write = this.backend.writeClipboard?.bind(this.backend);
        if (!read || !write) return yield* clipboardUnsupportedError();
        const previous = yield* timedComputerLeg(
          "dispatch",
          read().pipe(Effect.orElseSucceed(() => undefined)),
        );
        yield* timedComputerLeg("dispatch", write(text));
        let restored = false;
        // The restore runs whether or not the shortcut dispatched: the payload
        // is already on the clipboard either way, and leaving it there leaks
        // the agent's text into the next paste the human makes.
        const restore = Effect.suspend(() => {
          if (previous === undefined) return Effect.void;
          return Effect.andThen(
            timedComputerLeg("settle", Effect.sleep(COMPUTER_PASTE_RESTORE_MS)),
            write(previous).pipe(
              Effect.match({
                onFailure: () => {
                  restored = false;
                },
                onSuccess: () => {
                  restored = true;
                },
              }),
            ),
          );
        });
        const result = yield* this.runKeyboardDispatch(
          threadId,
          windowId,
          this.backend.hotkey(
            this.agentDialect === "macos" ? ["meta", "v"] : ["ctrl", "v"],
            windowId,
          ),
        ).pipe(Effect.ensuring(restore));
        return {
          ...(yield* this.actionResult(threadId, "computer_paste", undefined, result, windowId)),
          // True only when what the user copied is back in place: a clipboard
          // with no text had nothing to restore, and a failed restore reports
          // false rather than claim their contents are safe.
          clipboardRestored: restored,
        };
      }),
    );
  }

  setValue(
    threadId: string | undefined,
    target: ComputerTarget,
    value: string,
  ): Effect.Effect<ComputerActionResult, ComputerOperationError> {
    return this.withSemanticControl(
      threadId,
      target.windowId,
      Effect.gen({ self: this }, function* () {
        // Preferred over click-then-type when the target carries a live
        // element token: one atomic write instead of focus plus keystrokes.
        const resolved = yield* this.prepareSemanticDispatch(target, threadId);
        const result = yield* timedComputerLeg("dispatch", this.backend.setValue(resolved, value));
        return yield* this.actionResult(
          threadId,
          "computer_set_value",
          resolved.point,
          result,
          resolved.node.windowId ?? undefined,
        );
      }),
    );
  }

  performAction(
    threadId: string | undefined,
    target: ComputerTarget,
    action: string,
  ): Effect.Effect<ComputerActionResult, ComputerOperationError> {
    return this.withBackgroundProcessControl(
      threadId,
      target.windowId,
      Effect.gen({ self: this }, function* () {
        const resolved = yield* this.prepareSemanticDispatch(target, threadId);
        const result = yield* timedComputerLeg(
          "dispatch",
          this.backend.performAction(resolved, action),
        );
        return yield* this.actionResult(
          threadId,
          "computer_perform_action",
          resolved.point,
          result,
          resolved.node.windowId ?? undefined,
        );
      }),
    );
  }

  /**
   * Exact-range text selection through the accessibility layer — the
   * `computer_select_text` path. The target is resolved from fresh state so
   * the backend dispatches on a live element token, never on a stale
   * caller-supplied one; the backend's native read-back alone decides
   * `verified`. A `window_id`-only target may resolve to the window's sole
   * writable text control, the same rule `typeTextAt` applies — an ambiguous
   * or read-only match is refused rather than guessed.
   */
  selectText(
    threadId: string | undefined,
    target: ComputerTarget,
    range: ComputerTextRange,
  ): Effect.Effect<ComputerActionResult, ComputerOperationError> {
    return this.withSemanticControl(
      threadId,
      target.windowId,
      Effect.gen({ self: this }, function* () {
        const resolved = yield* this.prepareSemanticDispatch(target, threadId, true);
        const result = yield* timedComputerLeg(
          "dispatch",
          this.backend.selectText(resolved, range),
        );
        return yield* this.actionResult(
          threadId,
          "computer_select_text",
          resolved.point,
          result,
          resolved.node.windowId ?? undefined,
        );
      }),
    );
  }

  /**
   * Runs one agent tool call with this thread counted as driving the desktop.
   *
   * The count is kept whether or not this thread has a runtime record, because
   * the lease's in-flight guard reads it: while it was a field on the record,
   * every thread on a visible-desktop backend counted as idle from the first
   * call to the last, and the desktop could be taken from a thread in the
   * middle of a drag. Publishing the badge still requires a record, since a
   * thread nobody is watching has no panel to update.
   */
  withAgentActivity<A, E>(
    threadId: string,
    action: Effect.Effect<A, E>,
    signal?: DesktopSignal,
    turnId?: string,
    operationKey?: string,
  ): Effect.Effect<A, E | ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      yield* assertDesktopOperationAdmission;
      let authority = this.authorityRevocations.get(threadId);
      if (authority && Deferred.isDoneUnsafe(authority)) {
        // A revoked broadcast must not poison later calls: mint fresh so a
        // re-armed thread is not stillborn on the previous revocation.
        authority = undefined;
        this.authorityRevocations.delete(threadId);
      }
      if (!authority) {
        authority = makeDesktopAbort();
        this.authorityRevocations.set(threadId, authority);
      }
      const admissionSignal = composeDesktopSignals(signal, desktopSignal(authority));
      const execute = Effect.gen({ self: this }, function* () {
        // The raw id, not the pane-normalized one: a whitespace thread still
        // gets its revoked-or-suspended check, the same gate the input
        // wrappers apply to their resolved owner.
        yield* this.assertControlAuthority(threadId);
        const controller = makeDesktopAbort();
        let live = this.activeAuthorities.get(threadId);
        if (!live) {
          live = new Set();
          this.activeAuthorities.set(threadId, live);
        }
        const running = live;
        running.add(controller);
        const dropLive = Effect.sync(() => {
          running.delete(controller);
          if (running.size === 0) this.activeAuthorities.delete(threadId);
        });
        const run = withDesktopOperationSignal(desktopSignal(controller), action);
        const owner = agentThreadId(threadId);
        if (owner === undefined) return yield* run.pipe(Effect.ensuring(dropLive));
        if (turnId) this.authorityTurns.set(owner, turnId);
        const depth = (this.agentCallsInFlight.get(owner) ?? 0) + 1;
        this.agentCallsInFlight.set(owner, depth);
        if (depth === 1) this.publishCached(owner);
        // A failing release replaces the call's outcome, as a throwing
        // `finally` does.
        return yield* Effect.uninterruptibleMask((restore) =>
          restore(run).pipe(
            Effect.exit,
            Effect.flatMap((exit) =>
              Effect.andThen(Effect.andThen(dropLive, this.finishAgentCall(owner)), exit),
            ),
          ),
        );
      });
      // Entered around the queue handoff so a call's total covers its wait for
      // the desktop, not just the work after it wins.
      return yield* this.withComputerCall(
        operationKey
          ? this.operations.runScoped(operationKey, execute, admissionSignal)
          : this.operations.run(execute, admissionSignal),
      );
    });
  }

  /** The last in-flight call for `owner` ended: honour a deferred release. */
  private finishAgentCall(owner: string): Effect.Effect<void, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      const remaining = Math.max(0, (this.agentCallsInFlight.get(owner) ?? 1) - 1);
      if (remaining > 0) {
        this.agentCallsInFlight.set(owner, remaining);
        return;
      }
      this.agentCallsInFlight.delete(owner);
      this.releaseBackgroundControl(owner, undefined, true);
      if (
        this.lease?.threadId !== owner &&
        ![...this.backgroundLeases.values()].some((lease) => lease.threadId === owner)
      ) {
        this.authorityTurns.delete(owner);
      }
      if (this.lease?.threadId === owner && this.lease.releaseRequested) {
        const requestedTurnId = this.lease.releaseRequestedTurnId;
        // The deferred release is only valid while the lease still names
        // the turn it was requested for — and an anonymous request only
        // while the lease is still anonymous. A renewed lease drops it
        // rather than letting a dead turn's intent kill live work.
        const stillMatches =
          requestedTurnId === undefined
            ? this.lease.turnId === undefined
            : this.lease.turnId === requestedTurnId;
        if (stillMatches) {
          yield* withoutDesktopCancellation(this.releaseDesktopControl(owner, requestedTurnId));
        } else {
          delete this.lease.releaseRequested;
          delete this.lease.releaseRequestedTurnId;
          this.publishCached(owner);
        }
      } else {
        this.publishCached(owner);
      }
    });
  }

  /**
   * Whether the backend exposes the driver's CDP browser surface. Absent
   * means "no browser route": the gateway must not advertise the tools at
   * all, which is also the honest answer a desktop-only backend gives.
   */
  get supportsBrowser(): boolean {
    return this.backend.browser !== undefined;
  }

  /**
   * Dispatch one driver browser call for a thread. Browser work shares the
   * turn's authority revocation and caller signal with desktop work, but not
   * the desktop lease, the desktop coordinate space, the frame tap, or the
   * post-unlock observation gate: targets are opaque session-scoped
   * capabilities minted by the driver, and every result — including a
   * deliberate `status:"refused"` reply — is driver-produced. Calls for one
   * thread serialize on a browser lane keyed to the thread so lifecycle
   * transitions (prepare, navigate, end) cannot interleave mid-flight.
   */
  browserCall<E = never>(
    threadId: string,
    turnId: string | undefined,
    name: string,
    args: Record<string, unknown>,
    signal?: DesktopSignal,
    beforeDispatch?: Effect.Effect<void, E>,
  ): Effect.Effect<ComputerBrowserCallResult, ComputerOperationError | E> {
    const browser = this.backend.browser;
    if (!browser) {
      return Effect.fail(
        new ComputerBackendError({
          message: "This computer backend does not provide browser automation.",
          retryable: false,
        }),
      );
    }
    return this.withAgentActivity(
      threadId,
      Effect.gen({ self: this }, function* () {
        const operationSignal = yield* desktopOperationSignal;
        if (!operationSignal) {
          return yield* new ComputerBackendError({
            message: "Computer browser call ran outside an operation context.",
            retryable: false,
          });
        }
        yield* checkDesktopSignal(operationSignal);
        // Authorization can change while the thread's browser lane is busy.
        // Recheck after admission, then fence the native call against a stop
        // that arrives while this asynchronous check is still running.
        if (beforeDispatch) yield* beforeDispatch;
        yield* checkDesktopSignal(operationSignal);
        const windowed = name === "browser_prepare" && args.windowed === true;
        if (windowed) yield* this.spaceBroker.assertForegroundAllowed(threadId);
        const invoke = browser.call({
          name,
          args,
          task: { threadId, ...(turnId ? { turnId } : {}) },
          mutation: name !== "get_browser_state",
        });
        // Only a gateway recheck that passed can stamp a visible launch as
        // authorized; for one it includes visible use. Model arguments alone
        // cannot do so.
        return yield* beforeDispatch && windowed
          ? withDesktopDeliveryMode("foreground", invoke)
          : invoke;
      }),
      signal,
      turnId,
      `browser:${threadId}`,
    );
  }

  /**
   * Runs `run` inside a per-call context, creating one only when no enclosing
   * call already did. Tool calls arrive wrapped by `withAgentActivity`;
   * direct manager calls — pane input, tests — get one here so their legs
   * still measure. The context also carries a delivered action's effect proof
   * to the post-action observer, scoped to the call so no later call can
   * inherit it. With neither flag set it is a passthrough.
   */
  private withComputerCall<A, E, R>(run: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return Effect.flatMap(currentComputerCall, (current) => {
      if (current !== undefined) return run;
      return Effect.flatMap(createComputerCallContext, (context) => {
        if (context === undefined) return run;
        const timing = context.timing;
        return withComputerCallContext(
          context,
          timing === undefined
            ? run
            : run.pipe(
                Effect.tapCause(() => Effect.sync(() => timing.markFailed())),
                Effect.ensuring(timing.finish()),
              ),
        );
      });
    });
  }

  private canUseBackgroundTarget(): Effect.Effect<boolean> {
    return Effect.map(
      desktopDeliveryMode,
      (mode) => this.backend.exactTargetBackgroundInput === true && mode !== "foreground",
    );
  }

  private withSemanticControl<A, E>(
    threadId: string | undefined,
    windowId: string | undefined,
    action: Effect.Effect<A, E>,
  ): Effect.Effect<A, E | ComputerOperationError> {
    return Effect.flatMap(this.canUseBackgroundTarget(), (background) =>
      windowId && background
        ? this.withBackgroundWindowControl(threadId, windowId, action)
        : this.withDesktopControl(threadId, action),
    );
  }

  /** Keep a complete native gesture atomic without reserving unrelated apps for a whole turn. */
  private withBackgroundProcessControl<A, E>(
    threadId: string | undefined,
    windowId: string | undefined,
    action: Effect.Effect<A, E>,
  ): Effect.Effect<A, E | ComputerOperationError> {
    return Effect.flatMap(this.canUseBackgroundTarget(), (background) => {
      if (!windowId || !background) return this.withDesktopControl(threadId, action);
      return this.withBackgroundResourceControl(
        threadId,
        Effect.gen({ self: this }, function* () {
          const window = yield* this.resolveWindowTarget(threadId, windowId);
          if (window.pid === undefined || window.pid <= 0) {
            return yield* new ComputerBackendError({
              message:
                "Background input needs a verified application process for the exact window.",
            });
          }
          return { key: `process:${window.pid}`, pid: window.pid };
        }),
        () => action,
      );
    });
  }

  private withBackgroundAppControl(
    threadId: string | undefined,
    app: string,
    action: Effect.Effect<ComputerLaunchAppResult, ComputerOperationError>,
  ): Effect.Effect<ComputerLaunchAppResult, ComputerOperationError> {
    return Effect.flatMap(this.canUseBackgroundTarget(), (background) => {
      if (!background) return this.withDesktopControl(threadId, action);
      return this.withBackgroundResourceControl(
        threadId,
        Effect.gen({ self: this }, function* () {
          yield* this.assertDrivenAppAllowed(app);
          const apps = this.backend.listApps ? yield* this.backend.listApps() : undefined;
          const spelling = app.trim().toLowerCase();
          const matches =
            apps?.filter((candidate) =>
              [candidate.name, candidate.bundleId, candidate.launchPath].some(
                (name) => name?.toLowerCase() === spelling,
              ),
            ) ?? [];
          // Never guess which process LaunchServices will choose among several
          // running instances of the same app.
          const running = matches.filter((candidate) => candidate.running && candidate.pid > 0);
          if (running.length > 1) {
            return yield* new ComputerBackendError({
              message:
                "Several running applications match this launch. Use an exact existing window instead.",
            });
          }
          const target = running[0] ?? matches[0];
          const resource: BackgroundControlTarget = target?.running
            ? { key: `process:${target.pid}`, pid: target.pid }
            : {
                key: `application:${(target?.bundleId ?? target?.launchPath ?? target?.name ?? spelling).toLowerCase()}`,
              };
          return resource;
        }),
        (target) =>
          Effect.map(action, (result) => {
            // A cold launch now has a process identity. Keep its app reservation
            // attached to that pid, so another task cannot take its first window
            // while the launching task is observing it.
            const held = this.backgroundLeases.get(target.key);
            const pid = result.pid ?? result.window?.pid;
            if (held && held.threadId === agentThreadId(threadId) && pid !== undefined && pid > 0) {
              this.backgroundLeases.set(target.key, { ...held, target: { ...target, pid } });
            }
            return result;
          }),
      );
    });
  }

  private withBackgroundResourceControl<A, E>(
    threadId: string | undefined,
    resolve: Effect.Effect<BackgroundControlTarget, ComputerOperationError>,
    action: (target: BackgroundControlTarget) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      yield* assertDesktopOperationAdmission;
      const owner = agentThreadId(threadId);
      if (owner === undefined) this.lastUserDesktopInputAt = this.now();
      // Process-scoped native input and its observation remain one exclusive
      // queue transaction. Only logical ownership is narrower than the desktop.
      return yield* this.operations.run(
        Effect.gen({ self: this }, function* () {
          yield* this.assertControlAuthority(owner);
          yield* this.assertInputNotPaused(owner);
          const target = yield* resolve;
          yield* assertDesktopOperationActive;
          yield* this.claimBackgroundControl(owner, target);
          this.engageBackend();
          return yield* this.withComputerCall(action(target)).pipe(
            Effect.tapError((error) => Effect.sync(() => this.recordInputPause(owner, error))),
          );
        }),
      );
    });
  }

  private claimBackgroundControl(
    owner: string | undefined,
    target: BackgroundControlTarget,
  ): Effect.Effect<void, ComputerLeaseError> {
    return Effect.gen({ self: this }, function* () {
      if (owner === undefined) return;
      const now = this.now();
      if (this.lease && this.lease.threadId !== owner && !this.isLeaseStale(this.lease, now)) {
        return yield* new ComputerLeaseError();
      }
      if (this.lease && this.isLeaseStale(this.lease, now)) {
        this.authorityTurns.delete(this.lease.threadId);
        this.lease = null;
      }
      for (const [key, lease] of this.backgroundLeases) {
        if (this.isLeaseStale(lease, now)) {
          this.backgroundLeases.delete(key);
          this.clearEvictedBackgroundOwner(lease.threadId);
          continue;
        }
        const sameProcess = target.pid !== undefined && target.pid === lease.target.pid;
        const conflict =
          target.key === key || (sameProcess && (!target.windowId || !lease.target.windowId));
        if (conflict && lease.threadId !== owner) return yield* new ComputerLeaseError(true);
      }
      const claiming = yield* currentComputerTask;
      const turnId =
        (claiming?.threadId === owner ? claiming.turnId : undefined) ??
        this.authorityTurns.get(owner);
      const held = this.backgroundLeases.get(target.key);
      this.backgroundLeases.set(target.key, {
        threadId: owner,
        target,
        ...(turnId ? { turnId } : {}),
        lastActivityMs: now,
        ...(held?.threadId === owner && held.turnId === turnId && held.releaseRequested
          ? { releaseRequested: true, releaseRequestedTurnId: held.releaseRequestedTurnId }
          : {}),
      });
      if (held?.threadId !== owner) this.publishOwnershipCached();
    });
  }

  private publishOwnershipCached(): void {
    for (const threadId of this.threads.keys()) this.publishCached(threadId);
  }

  private clearEvictedBackgroundOwner(owner: string): void {
    if (
      this.lease?.threadId === owner ||
      [...this.backgroundLeases.values()].some((lease) => lease.threadId === owner)
    )
      return;
    this.authorityTurns.delete(owner);
    const state = this.threads.get(owner);
    if (state) state.paneSurfaced = false;
    this.publishOwnershipCached();
  }

  private releaseBackgroundControl(owner: string, turnId?: string, onlyRequested = false): void {
    let changed = false;
    for (const [key, lease] of this.backgroundLeases) {
      if (lease.threadId !== owner || (turnId && lease.turnId && lease.turnId !== turnId)) continue;
      if (
        onlyRequested &&
        (!lease.releaseRequested || lease.releaseRequestedTurnId !== lease.turnId)
      )
        continue;
      if ((this.agentCallsInFlight.get(owner) ?? 0) > 0) {
        lease.releaseRequested = true;
        lease.releaseRequestedTurnId = turnId ?? lease.turnId;
      } else {
        this.backgroundLeases.delete(key);
        changed = true;
      }
    }
    if (
      this.lease?.threadId !== owner &&
      ![...this.backgroundLeases.values()].some((lease) => lease.threadId === owner)
    ) {
      const state = this.threads.get(owner);
      if (state) state.paneSurfaced = false;
    }
    if (changed) this.publishOwnershipCached();
  }

  private withBackgroundWindowControl<A, E>(
    threadId: string | undefined,
    windowId: string,
    action: Effect.Effect<A, E>,
  ): Effect.Effect<A, E | ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      if ((yield* desktopDeliveryMode) === "foreground") {
        return yield* this.withDesktopControl(threadId, action);
      }
      yield* assertDesktopOperationAdmission;
      const owner = agentThreadId(threadId);
      // Pane input (no owning thread) is the human driving their own desktop:
      // stamp it so a foreground excursion cannot raise a window into the middle
      // of their interaction.
      if (owner === undefined) this.lastUserDesktopInputAt = this.now();
      return yield* this.operations.runScoped(
        windowId,
        Effect.gen({ self: this }, function* () {
          yield* this.assertControlAuthority(owner);
          yield* this.assertInputNotPaused(owner);
          const target = yield* this.resolveWindowTarget(threadId, windowId);
          yield* assertDesktopOperationActive;
          yield* this.claimBackgroundControl(owner, {
            key: `window:${windowId}`,
            windowId,
            ...(target.pid !== undefined ? { pid: target.pid } : {}),
          });
          this.engageBackend();
          return yield* this.withComputerCall(action).pipe(
            Effect.tapError((error) => Effect.sync(() => this.recordInputPause(owner, error))),
          );
        }),
      );
    });
  }

  /**
   * Take or renew the exclusive desktop lease for a mutating agent action, or
   * refuse the action because another conversation holds it.
   *
   * Ownership is implicit: the first thread to drive the desktop owns it, and
   * keeps owning it until its turn ends. There is no explicit acquire tool
   * because there is nothing sensible for a model to do with one — it would
   * either forget to release, or treat a refusal to acquire as a different
   * failure from a refusal to act.
   *
   * An undefined (or blank) thread is the human driving through the computer
   * pane, which the same rule as `emitAction` identifies. The human is not a
   * competing agent: they are the person the desktop belongs to, so pane input
   * neither takes the lease nor is ever refused by it.
   */
  private withDesktopControl<A, E>(
    threadId: string | undefined,
    action: Effect.Effect<A, E>,
    beforeClaim?: Effect.Effect<void, ComputerOperationError>,
  ): Effect.Effect<A, E | ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      yield* assertDesktopOperationAdmission;
      const owner = agentThreadId(threadId);
      // Pane input (no owning thread) is the human driving their own desktop:
      // stamp it so a foreground excursion cannot raise a window into the middle
      // of their interaction. Stamped before the queue so a queued agent call
      // sees the interaction that preceded it.
      if (owner === undefined) this.lastUserDesktopInputAt = this.now();
      if (
        owner &&
        this.lease &&
        this.lease.threadId !== owner &&
        !this.isLeaseStale(this.lease, this.now())
      ) {
        return yield* new ComputerLeaseError();
      }
      return yield* this.operations.run(
        Effect.gen({ self: this }, function* () {
          yield* this.assertControlAuthority(owner);
          // Readiness first: a paused thread is refused before it can take the
          // lease, clear focus, or announce itself — all of which
          // claimDesktopControl would otherwise do ahead of a refusal that
          // sends nothing.
          yield* this.assertInputNotPaused(owner);
          // Admission belongs before the lease claim: even clearFocusWindow and
          // cursor setup may cold-start a native process. A refused foreground
          // call must not start it, take the lease, or publish a driving
          // session. Run inside the queue so recent human input is checked at
          // dispatch.
          if (beforeClaim) yield* beforeClaim;
          yield* this.claimDesktopControl(threadId);
          yield* assertDesktopOperationActive;
          return yield* this.withComputerCall(action).pipe(
            Effect.tapError((error) => Effect.sync(() => this.recordInputPause(owner, error))),
          );
        }),
      );
    });
  }

  private refreshInputPause(
    windowId: string,
    windows: readonly ComputerWindow[],
  ): Effect.Effect<void, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      const checkInputReady = this.backend.checkInputReady?.bind(this.backend);
      if (!checkInputReady) return;
      const observingThread = (yield* currentComputerTask)?.threadId;
      const observedWindow = windows.find((window) => window.id === windowId);
      const paused = [...this.threads.entries()].filter(
        ([threadId, state]) =>
          (observingThread === undefined || observingThread === threadId) &&
          state.inputPause &&
          (!state.inputPause.windowId ||
            state.inputPause.windowId === windowId ||
            (state.inputPause.pid !== undefined &&
              observedWindow?.pid === state.inputPause.pid &&
              observedWindow.visible &&
              !observedWindow.minimized &&
              observedWindow.onCurrentSpace !== false) ||
            (state.inputPause.pid === undefined &&
              !windows.some((window) => window.id === state.inputPause?.windowId))),
      );
      if (paused.length === 0) return;
      const snapshots = paused.map(([threadId, state]) => ({
        threadId,
        state,
        pause: state.inputPause,
        // The generation this pause was observed under. A disable/re-enable
        // between the snapshot and the clear must not launder an old pause away.
        generation: this.controlState.get(threadId).generation,
      }));
      const ready = yield* Effect.result(checkInputReady(windowId));
      // Read-only perception remains available while input is paused.
      if (ready._tag === "Failure") return;
      yield* assertDesktopOperationActive;
      for (const { threadId, state, pause, generation } of snapshots) {
        if (this.threads.get(threadId) !== state || state.inputPause !== pause) continue;
        // The window is ready, but only a still-authorized thread may resume on
        // that news: a thread revoked (or re-armed to a new generation) while
        // the readiness probe was in flight keeps its pause.
        if (!this.canActivateControl(threadId, generation)) continue;
        delete state.inputPause;
        state.lastError = null;
        this.publishCached(threadId);
      }
    });
  }

  private claimDesktopControl(
    threadId: string | undefined,
  ): Effect.Effect<void, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      // Before the early return, not after it: pane input belongs to no thread
      // and takes no lease, but it is still the human asking this backend to
      // drive their desktop, which is exactly what engagement means.
      this.engageBackend();
      const owner = agentThreadId(threadId);
      if (owner === undefined) return;
      // The window list as it stood before this action, so the observer can
      // tell "nothing happened" apart from "a window opened that the capture
      // could not see". Free after the first action: every publish and every
      // targeting read refreshes the cache.
      this.preActionWindowIds =
        this.lastKnownWindowIds ??
        (yield* this.readWindows().pipe(
          Effect.map(windowIdSet),
          Effect.orElseSucceed(() => undefined),
        ));
      const now = this.now();
      for (const [key, lease] of this.backgroundLeases) {
        if (this.isLeaseStale(lease, now)) {
          this.backgroundLeases.delete(key);
          this.clearEvictedBackgroundOwner(lease.threadId);
        } else if (lease.threadId !== owner) return yield* new ComputerLeaseError();
      }
      const held = this.lease;
      const heldStale = held !== null && this.isLeaseStale(held, now);
      if (held && held.threadId !== owner && !heldStale) {
        return yield* new ComputerLeaseError();
      }
      // A dead lease's turn stamp is dead with it: an anonymous re-claim must
      // not inherit it, and an evicted owner's entry can never be useful again.
      if (held && heldStale) {
        this.authorityTurns.delete(held.threadId);
        // The evicted owner's surfaced surface died with its control period.
        // Clearing here because its release returns early on the lease-owner
        // check in releaseDesktopControl, never reaching the reset there.
        const evicted = this.threads.get(held.threadId);
        if (evicted) evicted.paneSurfaced = false;
      }
      const changed = held?.threadId !== owner;
      yield* assertDesktopOperationActive;
      if (changed) {
        if (this.backend.clearFocusWindow) yield* this.backend.clearFocusWindow();
        yield* assertDesktopOperationActive;
      }
      // Stamp the claiming caller's own turn when it carries one; the map only
      // fills the gap for turnId-less callers sharing the owning turn's window.
      const claimingTask = yield* currentComputerTask;
      const stampedTurnId =
        (claimingTask && agentThreadId(claimingTask.threadId) === owner
          ? claimingTask.turnId
          : undefined) ?? this.authorityTurns.get(owner);
      const lease: DesktopLease = {
        threadId: owner,
        ...(stampedTurnId ? { turnId: stampedTurnId } : {}),
        lastActivityMs: now,
        ...(!changed && held?.releaseRequested
          ? { releaseRequested: true, releaseRequestedTurnId: held.releaseRequestedTurnId }
          : {}),
      };
      this.lease = lease;
      if (held && heldStale) {
        yield* this.recordLeaseLifecycle("stale-reclaimed", held, {
          idleMs: now - held.lastActivityMs,
          nextThreadId: owner,
        });
      }
      if (changed || heldStale || held?.turnId !== lease.turnId) {
        yield* this.recordLeaseLifecycle("acquired", lease);
      }
      if (changed) {
        yield* this.announceDrivingAgent(owner);
        // Both panels change: the new owner stops being blocked, and every
        // other thread starts being.
        yield* this.publishAllThreads();
      }
    });
  }

  /** Lifecycle evidence contains identities and timing, never input or titles. */
  private recordLeaseLifecycle(
    event: "acquired" | "release-requested" | "released" | "stale-reclaimed",
    lease: DesktopLease,
    detail?: { readonly idleMs: number; readonly nextThreadId: string },
  ): Effect.Effect<void> {
    return Effect.logInfo("[computer] desktop lease").pipe(
      Effect.annotateLogs({
        ts: DateTime.formatIso(DateTime.makeUnsafe(this.now())),
        event,
        threadId: lease.threadId,
        ...(lease.turnId ? { turnId: lease.turnId } : {}),
        ...detail,
      }),
    );
  }

  /**
   * Names the thread driving the desktop so a backend that draws an agent
   * cursor can label it. Best effort: a missing or failed label is a cosmetic
   * loss, and must never turn into a refused action.
   */
  private announceDrivingAgent(threadId: string | null): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      yield* this.cursorActivity.setOwner(threadId);
      if (!this.backend.setDrivingAgent) return;
      const label = threadId === null ? null : (this.threadLabels.get(threadId) ?? null);
      yield* Effect.ignore(this.backend.setDrivingAgent(label));
    });
  }

  /**
   * The display name for a thread's agent cursor badge. Pushed in by the tool
   * layer, which is the only place that knows a thread's title, rather than
   * queried from here — the manager is built without any orchestration
   * dependency and reading a title on every action would put a database read
   * inside the lease claim.
   */
  setThreadLabel(threadId: string, label: string | null): void {
    const owner = agentThreadId(threadId);
    if (owner === undefined) return;
    const trimmed = label?.trim();
    if (trimmed) {
      if (this.threadLabels.get(owner) === trimmed) return;
      this.threadLabels.delete(owner);
      this.threadLabels.set(owner, trimmed);
      for (const id of this.threadLabels.keys()) {
        if (this.threadLabels.size <= 256) break;
        if (id === owner || id === this.lease?.threadId || this.agentCallsInFlight.has(id))
          continue;
        this.threadLabels.delete(id);
      }
    } else {
      if (!this.threadLabels.delete(owner)) return;
    }
    // Only when this thread is the one on screen; every other thread's label is
    // just recorded for whenever it takes the desktop.
    if (this.lease?.threadId === owner) this.runFork(this.announceDrivingAgent(owner));
  }

  /**
   * Release the desktop the moment the owning thread stops being able to drive
   * it — its turn reached a terminal state, or its provider session exited.
   * This is the lease's primary release path; idle expiry only covers a runtime
   * that died without reporting either.
   *
   * A terminal event names its turn so a late completion cannot release a lease
   * already renewed by a newer turn. Session teardown may release the whole
   * thread by omitting the turn id.
   */
  releaseDesktopControl(
    threadId: string,
    turnId?: string,
  ): Effect.Effect<void, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      const owner = agentThreadId(threadId);
      if (owner === undefined) return;
      this.spaceBroker.release(owner, turnId);
      this.releaseBackgroundControl(owner, turnId);
      // A normal thread-level completion must keep its queued preview/cursor
      // cleanup on the observed turn, just like the lease release below. Real
      // control revocation/removal is thread-wide and also closes older tasks.
      const cleanupTurnId =
        turnId ??
        (!this.controlDisabled(owner) &&
        !this.suspendedThreads.has(owner) &&
        this.lease?.threadId === owner
          ? this.lease.turnId
          : this.authorityTurns.get(owner));
      // Preview teardown must not block lifecycle ingestion or an in-flight
      // operation's finalizer. In particular, awaiting it on the deferred path
      // would prevent the operation from draining and leave the lease held.
      const endTask = this.backend.endTask?.bind(this.backend);
      if (endTask) {
        this.runFork(
          endTask(owner, cleanupTurnId).pipe(
            Effect.catch((error) =>
              this.recordThreadError(owner, `Preview cleanup failed: ${errorMessage(error)}`),
            ),
          ),
        );
      }
      const lease = this.lease;
      if (lease?.threadId !== owner) {
        if (
          (this.agentCallsInFlight.get(owner) ?? 0) === 0 &&
          ![...this.backgroundLeases.values()].some((held) => held.threadId === owner) &&
          (!turnId || this.authorityTurns.get(owner) === turnId)
        )
          this.authorityTurns.delete(owner);
        this.publishCached(owner);
        return;
      }
      if (turnId && lease.turnId && lease.turnId !== turnId) return;
      if ((this.agentCallsInFlight.get(owner) ?? 0) > 0) {
        if (!lease.releaseRequested) {
          yield* this.recordLeaseLifecycle("release-requested", lease);
        }
        lease.releaseRequested = true;
        // A thread-level release names no turn: stamp whoever holds the lease
        // at request time so a newer turn's renewal is not torn down by a
        // stale deferred release.
        lease.releaseRequestedTurnId = turnId ?? lease.turnId;
        return;
      }
      const releasedTurnId = lease.turnId;
      yield* this.operations.run(
        Effect.gen({ self: this }, function* () {
          const current = this.lease;
          if (current?.threadId !== owner) return;
          // The queue can admit a newer turn before this release gets its slot.
          // Even a thread-level teardown belongs to the turn observed above.
          if (current.turnId !== releasedTurnId) return;
          if (this.backend.clearFocusWindow) yield* this.backend.clearFocusWindow();
          yield* this.recordLeaseLifecycle("released", current);
          this.lease = null;
          // The released turn is no longer this thread's authority: a later
          // turnId-less caller must claim anonymously, not inherit a stale
          // stamp a duplicate release could still match.
          this.authorityTurns.delete(owner);
          const runtime = this.threads.get(owner);
          if (runtime) runtime.paneSurfaced = false;
          yield* this.announceDrivingAgent(null);
        }),
      );
      yield* this.publishAllThreads();
    });
  }

  /**
   * Stale only once nothing is in flight: a call that is still running holds
   * the pointer or the keyboard right now, and elapsed time since it started
   * says nothing about whether it has finished.
   */
  private isLeaseStale(lease: DesktopLease, now: number): boolean {
    if (now - lease.lastActivityMs < this.leaseIdleMs) return false;
    return (this.agentCallsInFlight.get(lease.threadId) ?? 0) === 0;
  }

  recordThreadError(threadId: string, message: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      const state = this.threads.get(threadId);
      if (!state) return Effect.void;
      state.reportedError = clampComputerMessage(
        message,
        "The computer backend reported an error without a message.",
      );
      return Effect.ignore(this.publish(threadId));
    });
  }

  /**
   * Adds a remote-preview frame sink until the surrounding scope closes. A pane
   * attach is a user asking to watch the desktop, which is a real use: the
   * stream cannot exist without a connected backend anyway. The stream
   * detaches once nobody is watching.
   */
  subscribeFrames(sink: FrameSink): Effect.Effect<void, never, Scope.Scope> {
    return Effect.gen({ self: this }, function* () {
      this.engageBackend();
      // Finalizers run in reverse, so this detach check runs after the
      // transport has removed the sink below.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (this.transport.streamSubscriberCount(this.computerId) > 0) return;
          this.streamDesired = false;
          this.streamEpoch += 1;
          this.runFork(
            this.reconcileStream().pipe(Effect.catch((error) => this.recordError(error))),
          );
        }),
      );
      yield* this.transport.subscribe(this.computerId, sink);
      this.streamDesired = true;
      this.streamEpoch += 1;
      this.runFork(this.reconcileStream().pipe(Effect.catch((error) => this.recordError(error))));
    });
  }

  requestKeyframe(): Effect.Effect<void, ComputerOperationError> {
    return Effect.suspend(() => {
      if (!this.streamAttached || this.transport.streamSubscriberCount(this.computerId) === 0) {
        return Effect.void;
      }
      const epoch = this.streamEpoch;
      // Forked so an interrupted caller only stops waiting: the detach/attach
      // fallback cut short would leave a watched stream detached, or attached
      // without `streamAttached` for dispose to tear down.
      const transition = this.enqueueStreamTransition(
        Effect.gen({ self: this }, function* () {
          if (!this.isStreamWanted(epoch) || !this.streamAttached) return;
          if (this.backend.requestKeyframe) {
            yield* this.backend.requestKeyframe();
            return;
          }
          yield* this.backend.detachStream();
          this.streamAttached = false;
          this.transport.reset(this.computerId);
          if (!this.isStreamWanted(epoch)) return;
          yield* this.backend.attachStream();
          if (!this.isStreamWanted(epoch)) {
            this.streamAttached = false;
            this.transport.reset(this.computerId);
            yield* this.backend.detachStream();
            return;
          }
          this.streamAttached = true;
        }),
      );
      return Fiber.join(this.runFork(transition));
    });
  }

  /** Waits for every attach/detach transition queued so far. */
  get flushStreamTransitions(): Effect.Effect<void> {
    return Effect.suspend(() => Deferred.await(this.streamTransition));
  }

  handleThreadRemoved(threadId: string): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      this.spaceBroker.release(threadId);
      // Cancel first, before the suspend below can yield: removal revokes
      // authority, and a prompt admitted a moment earlier must settle now
      // rather than at the gate's timeout.
      yield* this.approvals.cancelThread(threadId);
      this.suspendedThreads.add(threadId);
      // A failed stop (e.g. preview cleanup failing inside the release) must
      // not skip removal — a removed thread that keeps its lease can reappear
      // as the desktop's owner until the idle backstop fires. Bounded: a
      // wedged in-flight op must not stall removal forever.
      yield* Effect.ignore(
        withControlTeardownTimeout(Effect.flatMap(this.revokeControl(threadId), Fiber.join)),
      );
      this.publishChains.delete(threadId);
      this.publishWaiters.delete(threadId);
      this.threads.delete(threadId);
      this.threadLabels.delete(threadId);
      this.authorityTurns.delete(threadId);
      this.authorityRevocations.delete(threadId);
      this.activeAuthorities.delete(threadId);
      // Deleted after the thread state, so the resulting publish cannot
      // recreate it: a removed thread must not reappear as a lease holder.
      yield* Effect.ignore(withControlTeardownTimeout(this.releaseDesktopControl(threadId)));
      // Browser sessions are thread-scoped, not lease-scoped: a browser-only
      // thread may never have held the desktop lease, so teardown cannot ride
      // the release. Failure is tolerated — the driver's transport-EOF reaper
      // is the backstop — and a wedge is bounded like the rest of teardown.
      const browser = this.backend.browser;
      const endThread = browser?.endThread?.bind(browser);
      if (endThread) yield* Effect.ignore(withControlTeardownTimeout(endThread(threadId)));
    });
  }

  handleThreadRestored(threadId: string): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      // A failed pending stop must not keep a restored thread suspended
      // forever — a failed teardown is still a settled teardown.
      const pending = this.pendingStops.get(threadId);
      if (pending) yield* Fiber.await(pending);
      this.suspendedThreads.delete(threadId);
      this.authorityRevocations.delete(threadId);
    });
  }

  /** Runs once, when the scope `make` was given closes. */
  private dispose(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (this.disposed) return;
      this.disposed = true;
      this.spaceBroker.dispose();
      yield* this.cursorActivity.dispose;
      // A disable still writing must reach disk before the scope interrupts it.
      yield* Effect.ignore(
        withControlTeardownTimeout(Fiber.awaitAll(this.pendingControlWrites.values())),
      );
      // Teardown cannot depend on the host still answering: an unreachable
      // endpoint means the input path it owned is already gone, so the wait is
      // bounded like every other teardown leg.
      if (this.backend.stopInput) {
        yield* Effect.ignore(withControlTeardownTimeout(this.backend.stopInput()));
      }
      // close aborts live work before its drain waits, so a wedged operation
      // can only cost the drain — never the abort or the teardown that follows.
      yield* Effect.ignore(withControlTeardownTimeout(this.operations.close));
      if (this.windowsPublishTimer) yield* Fiber.interrupt(this.windowsPublishTimer);
      this.windowsPublishTimer = undefined;
      this.windowsPublishPending = false;
      if (this.errorRepublishTimer) yield* Fiber.interrupt(this.errorRepublishTimer);
      this.errorRepublishTimer = undefined;
      this.streamDesired = false;
      this.streamEpoch += 1;
      yield* Effect.ignore(
        this.enqueueStreamTransition(
          Effect.suspend(() => {
            if (!this.streamAttached) return Effect.void;
            this.streamAttached = false;
            this.transport.reset(this.computerId);
            return this.backend.detachStream();
          }),
        ),
      );
      yield* this.backend.dispose();
      yield* PubSub.shutdown(this.eventHub);
      yield* this.auditLog.flush;
    });
  }

  private reconcileStream(): Effect.Effect<void, ComputerOperationError> {
    return this.enqueueStreamTransition(
      Effect.gen({ self: this }, function* () {
        if (this.disposed || !this.streamDesired) {
          if (!this.streamAttached) return;
          this.streamAttached = false;
          this.transport.reset(this.computerId);
          yield* this.backend.detachStream();
          return;
        }
        if (this.streamAttached) return;
        const epoch = this.streamEpoch;
        yield* this.backend.attachStream();
        if (!this.isStreamWanted(epoch)) {
          yield* this.backend.detachStream();
          this.transport.reset(this.computerId);
          return;
        }
        this.streamAttached = true;
      }),
    );
  }

  /** Runs `action` after every transition queued before it, in order. */
  private enqueueStreamTransition<E>(action: Effect.Effect<void, E>): Effect.Effect<void, E> {
    return Effect.suspend(() => {
      const previous = this.streamTransition;
      const next = Deferred.makeUnsafe<void>();
      this.streamTransition = next;
      return Deferred.await(previous).pipe(
        Effect.andThen(action),
        Effect.ensuring(
          Effect.suspend(() =>
            Deferred.isDoneUnsafe(previous)
              ? Deferred.succeed(next, undefined)
              : // Interrupted while waiting: the chain still waits for the
                // transition ahead before releasing the next one.
                Effect.sync(() => {
                  this.runFork(
                    Deferred.await(previous).pipe(
                      Effect.andThen(Deferred.succeed(next, undefined)),
                    ),
                  );
                }),
          ),
        ),
      );
    });
  }

  /**
   * Frames travel on the binary transport and nowhere else. A parallel
   * `computer.frame` notice on the JSON event channel used to be emitted here
   * too; its only consumer read the header and did nothing with it, so every
   * still frame paid for a serialized event that told no one anything.
   */
  private handleFrame(frame: ComputerStreamFrame): void {
    if (this.disposed || (!this.streamDesired && !this.streamAttached)) return;
    this.transport.publish(this.computerId, frame);
  }

  /**
   * Coordinates plus a window id are a window-scoped click: the point is
   * resolved exactly as a bare coordinate, and the window id only decides which
   * window is raised and receives the input. A label or role instead means the
   * coordinate is at most a hint, so those keep going through AT-SPI
   * resolution, which owns the final point.
   */
  private assertTargetCanUseCoordinates(
    target: ComputerTarget,
  ): Effect.Effect<void, ComputerTargetError> {
    if (!observedComputerTargetNode(target)) return Effect.void;
    return Effect.fail(
      new ComputerTargetError({
        code: "computer_target_refused",
        message:
          "This observed element does not support the requested exact pointer action. Use an advertised semantic action or explicitly target a current screenshot; no coordinate fallback was sent.",
      }),
    );
  }

  private resolvePointTarget(
    target: ComputerTarget,
    threadId: string | undefined,
  ): Effect.Effect<ResolvedPointTarget, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      if (hasCoordinates(target) && !hasLabelFields(target)) {
        yield* this.spaceBroker.assertTargetBound(agentThreadId(threadId), target.windowId);
        const point = yield* this.resolveCoordinatePoint(target);
        if (target.windowId === undefined) {
          // The compositor routes a bare point to whatever is topmost at it, so
          // the denylist answers the same question the occlusion rules already
          // ask: which window would actually take this input. When stacking
          // cannot pick one — several windows cover the point and the list
          // carries no order — the check closes against every covering window:
          // the denied surface might be the one input reaches.
          const windows = yield* this.readWindows();
          const topmost = topmostWindowAtPoint(windows, point);
          if (topmost !== undefined) {
            yield* this.assertWindowInputAllowed(threadId, topmost.id);
          } else {
            for (const window of windows) {
              if (!window.visible || window.minimized) continue;
              if (!rectContainsPoint(window.bounds, point)) continue;
              yield* this.assertWindowInputAllowedWindow(threadId, window);
            }
          }
          return { point };
        }
        const windowId = target.windowId;
        const occlusion = yield* this.scopedPointOcclusion(point, windowId);
        yield* this.assertWindowInputAllowed(threadId, windowId);
        // A denied surface sitting over the scoped point can still take the
        // input — the raise the covering list waits on may fail, and an
        // unranked window list cannot even prove what covers what — so the
        // point refuses while any window that could intercept it is denied.
        if (agentThreadId(threadId) !== undefined) {
          const suspects =
            occlusion.covering.length > 0
              ? occlusion.covering
              : occlusion.ranked
                ? []
                : occlusion.windows.filter(
                    (window) =>
                      window.id !== windowId &&
                      window.visible &&
                      !window.minimized &&
                      rectContainsPoint(window.bounds, point),
                  );
          for (const window of suspects) {
            yield* this.assertWindowInputAllowedWindow(threadId, window);
          }
        }
        return { point, windowId, covering: occlusion.covering };
      }
      if (hasSemanticFields(target)) {
        const resolved = yield* this.resolveSemanticTarget(target);
        if (resolved.node.windowId) {
          yield* this.assertWindowInputAllowed(threadId, resolved.node.windowId);
        }
        return {
          point: resolved.point,
          semantic: resolved,
          ...(resolved.node.windowId ? { windowId: resolved.node.windowId } : {}),
        };
      }
      return yield* new ComputerTargetError({
        code: "computer_target_invalid",
        message: "Computer actions require x/y coordinates or a labelled target.",
      });
    });
  }

  private resolveCoordinatePoint(
    target: ComputerTarget,
  ): Effect.Effect<ComputerPoint, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      if (target.windowId && hasCoordinates(target)) {
        const window = (yield* this.readWindows()).find(
          (candidate) => candidate.id === target.windowId,
        );
        const bounds = window?.bounds;
        const observed = (target as ComputerTarget & { observedWindowBounds?: ComputerRect })
          .observedWindowBounds;
        if (window && !bounds)
          return yield* new ComputerTargetError({
            code: "computer_target_offscreen",
            message: "The target window exposes no geometry.",
          });
        if (
          !bounds ||
          (observed &&
            (bounds.x !== observed.x ||
              bounds.y !== observed.y ||
              bounds.width !== observed.width ||
              bounds.height !== observed.height))
        )
          return yield* new ComputerTargetError({
            code: "computer_target_not_found",
            message:
              "The exact window closed or moved since this screenshot. Observe again before acting.",
          });
        if (
          target.x < bounds.x ||
          target.y < bounds.y ||
          target.x >= bounds.x + bounds.width ||
          target.y >= bounds.y + bounds.height
        )
          return yield* new ComputerTargetError({
            code: "computer_target_offscreen",
            message: "The coordinate is outside the exact target window.",
          });
        return { x: target.x, y: target.y };
      }
      const screenSize = yield* this.backend.getScreenSize();
      return yield* resolveComputerPoint(target, screenSize).pipe(
        Effect.catchIf(
          (error) => error.code === "computer_target_offscreen",
          (error) =>
            Effect.gen({ self: this }, function* () {
              const state = yield* this.backend
                .getState({
                  includeTree: true,
                  ...(target.windowId ? { windowId: target.windowId } : {}),
                })
                .pipe(Effect.orElseSucceed(() => undefined));
              return yield* new ComputerTargetError({
                code: error.code,
                message: error.message,
                candidates: state?.root ? computerTargetCandidates(state.root) : [],
              });
            }),
        ),
      );
    });
  }

  /**
   * Checks a scoped coordinate against the window it names, and reports the
   * windows stacked above it that also contain the point.
   *
   * A scoped click is refused rather than redirected. Input is routed to the
   * named window regardless of what covers that coordinate, so a point outside
   * its bounds would deliver a click to a part of the window that does not
   * exist — the one failure mode scoping is meant to remove. The covering list
   * comes from the same window read, so the raise path downstream never has to
   * repeat it.
   */
  private scopedPointOcclusion(
    point: ComputerPoint,
    windowId: string,
  ): Effect.Effect<
    {
      readonly covering: readonly ComputerWindow[];
      readonly windows: readonly ComputerWindow[];
      readonly ranked: boolean;
    },
    ComputerOperationError
  > {
    return Effect.gen({ self: this }, function* () {
      const windows = yield* this.readWindows();
      const window = windows.find((candidate) => candidate.id === windowId);
      if (!window) return yield* windowNotFoundError(windowId);
      const bounds = window.bounds;
      if (!bounds) {
        // Scoping exists to guarantee the point is inside the named window. A
        // display server with no geometry cannot answer that, and letting the
        // click through unchecked would silently drop the guarantee the caller
        // asked for by passing window_id at all.
        return yield* new ComputerTargetError({
          code: "computer_target_offscreen",
          message:
            `This desktop reports no geometry for window ${JSON.stringify(windowId)}, so a coordinate ` +
            "cannot be checked against it. Drop window_id to click whatever is topmost at that point, " +
            "or target the control by label instead.",
        });
      }
      if (!rectContainsPoint(bounds, point)) {
        return yield* new ComputerTargetError({
          code: "computer_target_offscreen",
          message:
            `Computer target (${point.x}, ${point.y}) is outside window ${JSON.stringify(windowId)}, ` +
            `which covers ${bounds.width}x${bounds.height} at (${bounds.x}, ${bounds.y}). ` +
            "Pass a coordinate inside those bounds, or drop window_id to click whatever is topmost.",
        });
      }
      return {
        covering: windowsCoveringPoint(windows, windowId, point),
        windows,
        ranked: window.stackingIndex !== undefined,
      };
    });
  }

  /**
   * Raise before focus: focus alone routes the agent's input to a window that
   * may still be buried, which leaves the human watching clicks land on pixels
   * they cannot see. Both calls are optional so a backend that supports neither
   * keeps working.
   *
   * A raise this desktop cannot perform is not by itself a failed action — the
   * compositor still routes the agent's input to the named window — so it only
   * refuses when a different window really does cover the point, which is the
   * one case where proceeding would deliver the click somewhere the caller did
   * not ask for and could not see coming.
   */
  private prepareResolvedTarget(
    target: PreparedTarget | undefined,
    threadId: string | undefined,
  ): Effect.Effect<void, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      const windowId = target?.windowId;
      yield* this.spaceBroker.assertTargetBound(agentThreadId(threadId), windowId);
      if (windowId === undefined) {
        yield* assertDesktopOperationActive;
        if (this.backend.clearFocusWindow) yield* this.backend.clearFocusWindow();
        return;
      }
      yield* this.assertWindowInputAllowed(threadId, windowId);
      yield* this.revealTarget(target);
      yield* assertDesktopOperationActive;
      if (this.backend.focusWindow) yield* this.backend.focusWindow(windowId);
    });
  }

  /** Restack without changing keyboard aim, including on a hover. */
  private revealTarget(
    target: PreparedTarget | undefined,
  ): Effect.Effect<void, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      // Cua decides whether exact background delivery is possible. Merely
      // selecting a target never authorizes persistent foreground promotion.
      if (this.backend.agentDialect === "macos") return;
      const windowId = target?.windowId;
      if (windowId === undefined) return;
      yield* assertDesktopOperationActive;
      const raiseFailure = yield* this.raiseTargetWindow(windowId);
      if (raiseFailure !== undefined && target?.point) {
        const covering = target.covering ?? (yield* this.coveringWindowsAt(target.point, windowId));
        if (covering.length > 0) {
          return yield* occludedTargetError(windowId, target.point, covering, raiseFailure);
        }
      }
    });
  }

  /**
   * Points the agent seat's keyboard at a window before a keystroke, or leaves
   * focus alone when the caller named none.
   *
   * Keyboard input carries no coordinate to scope it, so without a window it
   * lands wherever the seat's focus already is — usually where the last click
   * put it, which is what a click-then-type sequence depends on. Focus is
   * therefore never cleared here; only an explicit window moves it, and a stale
   * id fails before any key is sent rather than typing into another application.
   */
  private prepareKeyboardTarget(
    windowId: string | undefined,
    threadId: string | undefined,
  ): Effect.Effect<void, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.spaceBroker.assertTargetBound(agentThreadId(threadId), windowId);
      if (windowId === undefined) return;
      const windows = yield* this.readWindows();
      const window = windows.find((candidate) => candidate.id === windowId);
      if (window === undefined) return yield* windowNotFoundError(windowId);
      if (yield* this.canUseBackgroundTarget()) {
        yield* this.admitWindowTarget(threadId, window);
        return;
      }
      yield* this.prepareResolvedTarget({ windowId }, threadId);
    });
  }

  /**
   * The dispatch every focused-window keyboard action shares: aim the agent
   * seat's keyboard at the named window (or leave it where the last action
   * put it), prove the operation is still live, then inject and hand back
   * the backend's own result. Type, key press, hotkey and paste differ only
   * in the call each carries.
   */
  private runKeyboardDispatch<A, E>(
    threadId: string | undefined,
    windowId: string | undefined,
    dispatch: Effect.Effect<A, E>,
  ): Effect.Effect<A, E | ComputerOperationError> {
    return timedComputerLeg("resolve", this.prepareKeyboardTarget(windowId, threadId)).pipe(
      Effect.andThen(assertDesktopOperationActive),
      Effect.andThen(timedComputerLeg("dispatch", dispatch)),
    );
  }

  /**
   * The resolve-and-aim every element-grain mutation shares: the target is
   * resolved from fresh state, or keeps an observed ref's native identity for
   * the backend to revalidate. The point gets the same focus aim a click would, and the
   * operation must still be live before anything dispatches. Set-value,
   * perform-action and select-text differ only in the call each carries
   * afterward — and in whether a window-only target may name the sole
   * writable control.
   */
  private prepareSemanticDispatch(
    target: ComputerTarget,
    threadId: string | undefined,
    allowUniqueTextTarget = false,
  ): Effect.Effect<ComputerResolvedTarget, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      const resolved = yield* timedComputerLeg(
        "resolve",
        this.resolveSemanticTarget(target, allowUniqueTextTarget),
      );
      if ((yield* this.canUseBackgroundTarget()) && target.windowId) {
        yield* this.assertWindowInputAllowed(threadId, target.windowId);
      } else {
        yield* timedComputerLeg(
          "resolve",
          this.prepareResolvedTarget(semanticPointTarget(resolved), threadId),
        );
      }
      yield* assertDesktopOperationActive;
      return resolved;
    });
  }

  /** The restack, or the reason this desktop did not perform one. */
  private raiseTargetWindow(windowId: string): Effect.Effect<string | undefined> {
    const raise = this.backend.raiseWindow?.bind(this.backend);
    if (!raise) return Effect.succeed("this backend exposes no stacking control");
    return raise(windowId).pipe(
      Effect.as(undefined),
      Effect.catch((error) => Effect.succeed(errorMessage(error))),
    );
  }

  /**
   * Runs a pointer injection that named a window, and replaces the desktop's
   * bare refusal with something the caller can act on.
   *
   * The compositor refuses instead of retargeting, so a refusal is the one
   * failure that guarantees nothing was delivered — worth saying, because the
   * caller's alternative reading is that the control is broken. It reports only
   * which call it declined, so the cause has to be supplied here.
   */
  private injectScoped<A, E>(
    action: string,
    target: PreparedTarget,
    inject: Effect.Effect<A, E>,
  ): Effect.Effect<A, E | ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      yield* assertDesktopOperationActive;
      // The new-window baseline is taken here — after targeting, immediately
      // before inject — rather than only at lease claim: the targeting reads
      // above refreshed the window cache, so diffing against anything older
      // would report windows this action never opened. The claim-time baseline
      // stays as the fallback for inputs that never pass through here.
      if (this.lastKnownWindowIds !== undefined) {
        this.preActionWindowIds = this.lastKnownWindowIds;
      }
      return yield* timedComputerLeg("dispatch", inject);
    }).pipe(
      Effect.catchIf(
        (error) =>
          target.windowId !== undefined &&
          target.point !== undefined &&
          isComputerBackendError(error) &&
          error.rejectedOperation !== undefined,
        () => Effect.fail(refusedInjectionError(action, target.windowId!, target.point!)),
      ),
    );
  }

  private coveringWindowsAt(
    point: ComputerPoint,
    windowId: string,
  ): Effect.Effect<readonly ComputerWindow[]> {
    return this.readWindows().pipe(
      Effect.orElseSucceed((): readonly ComputerWindow[] => []),
      Effect.map((windows) => windowsCoveringPoint(windows, windowId, point)),
    );
  }

  private resolveSemanticTarget(
    target: ComputerTarget,
    allowUniqueTextTarget = false,
  ): Effect.Effect<ComputerResolvedTarget, ComputerOperationError> {
    return Effect.gen({ self: this }, function* () {
      const unnamedTarget = target.label === undefined && target.role === undefined;
      // Without a label or role the query matches every control in scope, and
      // the ambiguity refusal that follows would dump the whole tree at the
      // caller. Refuse up front, before paying for the accessibility walk, with
      // what is actually missing.
      if (unnamedTarget && (!allowUniqueTextTarget || !target.windowId)) {
        return yield* new ComputerTargetError({
          code: "computer_target_invalid",
          message:
            "This target does not name a control: window_id or coordinates alone match everything in scope. " +
            "Pass label (optionally with role and window_id) to pick a control, or use x/y coordinates " +
            "with the pointer tools. Only computer_scroll takes window_id alone, scrolling that window itself.",
        });
      }
      // A semantic resolve walks the accessibility tree before any input check
      // runs, and a denied app's tree is itself refused — ambiguity and
      // not-found errors otherwise carry its labels back as candidates. macOS
      // only answers scoped trees, so an unscoped walk there is already empty;
      // a desktop-wide tree on other dialects refuses while a denied window is
      // visible.
      if (target.windowId !== undefined) {
        yield* this.assertWindowContentAllowed(target.windowId);
      } else if (this.agentDialect !== "macos") {
        const denied = yield* this.deniedVisibleWindow();
        if (denied) return yield* new ComputerDenylistError(denied.match.app, denied.match.matched);
      }
      const observedNode = observedComputerTargetNode(target);
      if (observedNode) {
        if (!observedNode.windowId || observedNode.windowId !== target.windowId) {
          return yield* new ComputerTargetError({
            code: "computer_target_invalid",
            message: "The observed element and target name different windows; nothing was sent.",
          });
        }
        // The backend revalidates this original native token's window ancestry
        // and freshness at dispatch. Re-resolving a label/ordinal here could
        // silently give a stale ref the token of a different control.
        return { target, node: observedNode, point: activationPointForNode(observedNode) };
      }
      const scope = target.windowId ? { windowId: target.windowId } : {};
      let state = yield* this.backend.getState({
        includeTree: true,
        reuseRecentTree: true,
        ...scope,
      });
      if (!state.root) {
        return yield* new ComputerTargetError({
          code: "computer_target_not_found",
          message: "Computer accessibility state did not include a target tree.",
          notFound: true,
        });
      }
      const resolve = (
        root: NonNullable<ComputerState["root"]>,
      ): Effect.Effect<ComputerResolvedTarget, ComputerTargetError> =>
        Effect.map(
          unnamedTarget
            ? resolveComputerUniqueTextTarget(root, target.windowId!, allowUniqueTextTarget)
            : resolveComputerSemanticTarget(root, target, allowUniqueTextTarget),
          (match) => ({ target, ...match }),
        );
      const first = yield* Effect.result(resolve(state.root));
      if (first._tag === "Success") return first.success;
      let error = first.failure;
      // A tree served from the recent cache can miss a control that only just
      // appeared. Pay for one fresh walk before declaring it absent; on a
      // genuinely-missing target the extra walk is a rare error-path cost.
      // Other failure shapes (ambiguity, bad target) retrying cannot fix.
      if (error.code === "computer_target_not_found") {
        state = yield* this.backend.getState({ includeTree: true, ...scope });
        if (state.root) {
          const fresh = yield* Effect.result(resolve(state.root));
          if (fresh._tag === "Success") return fresh.success;
          // The miss is confirmed against fresh state; report its candidates.
          error = fresh.failure;
        }
      }
      // A truncated tree may simply not contain the control: name the narrow
      // query so the miss is recoverable instead of a dead end.
      if (error.code === "computer_target_not_found" && state.root?.truncated === true) {
        return yield* new ComputerTargetError({
          code: error.code,
          message: `${error.message} The accessibility tree was truncated; use computer_get_state with label_contains to narrow the list and check whether the control is present.`,
          candidates: error.candidates,
          notFound: true,
        });
      }
      return yield* error;
    });
  }

  /**
   * The window id is the one targeting resolved, so the result reports where
   * input was routed; a backend that reports its own window id wins, being
   * closer to what actually happened.
   */
  private actionResult(
    threadId: string | undefined,
    action: string,
    point: ComputerPoint | undefined,
    result: ComputerBackendActionResult | void,
    windowId?: string,
  ): Effect.Effect<ComputerActionResult> {
    return Effect.map(currentComputerCall, (call) => {
      const merged = computerBackendActionResult(this.computerId, action, {
        ...(point ? { point } : {}),
        ...(windowId !== undefined ? { windowId } : {}),
        ...(result === undefined ? {} : result),
      });
      // The verdict rides on the call context: the post-action observer reads
      // it for the conditional-settle waiver, and the timing line takes the
      // operation's name.
      call?.timing?.setOperation(action);
      call?.recordActionProof(result || undefined);
      this.emitAction(threadId, action, merged);
      // The pane's agent-cursor dot is fed from here, the one funnel every
      // pointer action passes through: without it the field stayed declared but
      // never assigned, and the overlay never rendered.
      const attributed = agentThreadId(threadId);
      const state = attributed ? this.threads.get(attributed) : undefined;
      if (attributed && state && merged.point) {
        state.cursor = merged.point;
        this.publishCached(attributed);
      }
      return merged;
    });
  }

  /**
   * Desktop activity is attributed to the thread that drove it so an observer
   * can tell one agent's work from another's. Pane input carries no thread and
   * stays unattributed rather than borrowing an unrelated thread id.
   */
  private emitAction(
    threadId: string | undefined,
    action: string,
    result?: ComputerActionResult,
  ): void {
    const attributed = agentThreadId(threadId);
    if (attributed) this.surfacePaneForAgent(attributed);
    this.emit({
      type: "computer.action",
      ...(result?.windowId ? { windowId: result.windowId } : {}),
      ...(result?.delivery ? { delivery: result.delivery } : {}),
      action,
      ok: true,
      ...(attributed ? { threadId: ThreadId.make(attributed) } : {}),
    });
  }

  /**
   * Put the desktop in front of the user the moment an agent starts driving it.
   * Emitted before the action event so the pane is already opening when the
   * first attributed action reaches the store. See paneSurfaced for the
   * once-per-thread rule. The request is emitted on visible-desktop backends
   * too — the client gates the actual opening on its auto-open preference, and
   * there the pane renders stills only.
   *
   * The runtime record is still created in that case, before the decision: it
   * is what carries this thread's activity count and last error, and a thread
   * that drives the desktop needs one whether or not a pane is opened for it.
   */
  private surfacePaneForAgent(threadId: string): void {
    // A removed thread must not resurrect: an action resolving after the
    // thread's deletion would otherwise recreate its runtime record and emit
    // pane requests for a thread that no longer exists.
    if (this.suspendedThreads.has(threadId)) return;
    const state = this.threadRuntime(threadId);
    if (state.paneSurfaced) return;
    state.paneSurfaced = true;
    this.emit({ type: "computer.open-pane-requested", threadId: ThreadId.make(threadId) });
  }

  /** Publishes a thread from cached state, without a backend read. */
  private publishCached(threadId: string): ThreadComputerState | undefined {
    const state = this.threads.get(threadId);
    if (!state || this.disposed) return undefined;
    state.version = ++this.nextStateVersion;
    const snapshot = this.threadSnapshot(threadId, state);
    state.reportedError = null;
    this.emit({ type: "computer.thread-state", state: snapshot });
    return snapshot;
  }

  /**
   * Serializes publishes per thread. Two overlapping publishes read the same
   * state, each bump `version`, and both emit — the second overwriting the
   * first with a *newer* version number but identical or older content, which
   * is how duplicate versions leaked to the pane. Serializing makes each
   * publish see its predecessor's state.
   */
  private publish(threadId: string): Effect.Effect<ThreadComputerState | undefined> {
    return Effect.suspend(() => {
      let lock = this.publishChains.get(threadId);
      if (!lock) {
        lock = Semaphore.makeUnsafe(1);
        this.publishChains.set(threadId, lock);
      }
      const held = lock;
      this.publishWaiters.set(threadId, (this.publishWaiters.get(threadId) ?? 0) + 1);
      return held
        .withPermits(1)(this.publishNow(threadId))
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              const left = (this.publishWaiters.get(threadId) ?? 1) - 1;
              if (left > 0) {
                this.publishWaiters.set(threadId, left);
                return;
              }
              this.publishWaiters.delete(threadId);
              if (this.publishChains.get(threadId) === held) this.publishChains.delete(threadId);
            }),
          ),
        );
    });
  }

  private publishNow(threadId: string): Effect.Effect<ThreadComputerState | undefined> {
    return Effect.gen({ self: this }, function* () {
      const state = this.threads.get(threadId);
      if (!state) return undefined;
      if (!this.physicalState && !this.physicalFailure) yield* this.refreshPhysicalState();
      if (this.physicalFailure) {
        // Error text the backend does not control, so it meets the contract's
        // bound here rather than failing the state payload that carries it.
        state.lastError = clampComputerMessage(
          this.physicalFailure,
          "The computer backend reported an error without a message.",
        );
      } else {
        const physical = this.physicalState;
        if (physical) {
          state.availability = physical.availability;
          if (physical.windows) state.windows = physical.windows;
          if (physical.screenSize) state.screenSize = physical.screenSize;
        }
        state.lastError = null;
      }
      if (this.disposed || this.threads.get(threadId) !== state) return undefined;
      state.version = ++this.nextStateVersion;
      const snapshot = this.threadSnapshot(threadId, state);
      // A reported error lands in exactly one publish — the panel keeps it
      // until the next refresh supersedes it, not forever.
      state.reportedError = null;
      this.emit({ type: "computer.thread-state", state: snapshot });
      return snapshot;
    });
  }

  private publishAllThreads(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      yield* this.refreshPhysicalState();
      this.publishAllDepth += 1;
      yield* Effect.forEach([...this.threads.keys()], (threadId) => this.publish(threadId), {
        discard: true,
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            this.publishAllDepth -= 1;
            if (this.publishAllDepth === 0 && this.windowsPublishPending) {
              this.windowsPublishPending = false;
              this.scheduleWindowsPublish();
            }
          }),
        ),
      );
    });
  }

  /**
   * Queue one republish for a window change, coalescing everything that arrives
   * before it runs — including the changes this pass's own window reads report,
   * which is the loop that made this necessary. A pass already running never
   * starts a second one on top of itself; it re-arms the timer on the way out.
   */
  private scheduleWindowsPublish(): void {
    if (this.disposed) return;
    if (this.publishAllDepth > 0) {
      this.windowsPublishPending = true;
      return;
    }
    if (this.windowsPublishTimer !== undefined) return;
    this.windowsPublishTimer = this.runFork(
      Effect.sleep(this.windowsPublishDebounceMs).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            this.windowsPublishTimer = undefined;
            return this.disposed ? Effect.void : this.publishAllThreads();
          }),
        ),
      ),
    );
  }

  /**
   * Republish every thread from cached state. A backend health transition
   * changes what a panel must show but nothing the backend could tell us, and
   * querying it from the handler of the supervision loop's own event would put
   * a round trip — and another connect attempt — on every failure the loop
   * reports, which is how a reconnect turns into a storm.
   */
  private republishAllThreads(): void {
    if (this.disposed) return;
    for (const [threadId, state] of this.threads) {
      state.version = ++this.nextStateVersion;
      this.emit({ type: "computer.thread-state", state: this.threadSnapshot(threadId, state) });
    }
  }

  /**
   * A runtime record that is not registered — for reads of a thread that has
   * no live state, where inserting one would resurrect it.
   */
  private newThreadRuntime(): ThreadComputerRuntimeState {
    return {
      version: ++this.nextStateVersion,
      lastError: null,
      reportedError: null,
      windows: [],
      screenSize: { width: 1, height: 1 },
      availability: {
        kind: "backend-unavailable",
        message: "Computer state has not been queried yet",
      },
      paneSurfaced: false,
    };
  }

  private threadRuntime(threadId: string): ThreadComputerRuntimeState {
    let state = this.threads.get(threadId);
    if (!state) {
      state = this.newThreadRuntime();
      this.threads.set(threadId, state);
    } else {
      this.threads.delete(threadId);
      this.threads.set(threadId, state);
    }
    for (const [id, candidate] of this.threads) {
      if (this.threads.size <= 256) break;
      if (
        id === threadId ||
        id === this.lease?.threadId ||
        this.agentCallsInFlight.has(id) ||
        this.publishChains.has(id) ||
        candidate.paneSurfaced ||
        candidate.inputPause
      )
        continue;
      this.threads.delete(id);
      this.threadLabels.delete(id);
    }
    return state;
  }

  private threadSnapshot(threadId: string, state: ThreadComputerRuntimeState): ThreadComputerState {
    const backgroundOwners = new Set(
      [...this.backgroundLeases.values()].map((lease) => lease.threadId),
    );
    const controlOwner =
      this.lease?.threadId ?? (backgroundOwners.has(threadId) ? threadId : undefined);
    return {
      threadId: ThreadId.make(threadId),
      controlGeneration: this.controlState.get(threadId).generation,
      version: state.version,
      computerId: this.computerId,
      windows: state.windows,
      screenSize: state.screenSize,
      ...(state.cursor ? { cursor: state.cursor } : {}),
      agentActive: (this.agentCallsInFlight.get(threadId) ?? 0) > 0,
      ...(this.activity && this.lease?.threadId === threadId ? { activity: this.activity } : {}),
      ...(state.inputPause ? { inputPause: state.inputPause } : {}),
      controlledByOtherThread: this.lease !== null && this.lease.threadId !== threadId,
      ...(backgroundOwners.size > 1 ? { sharedPreviewUnavailable: true } : {}),
      ...(controlOwner
        ? {
            controlOwnerThreadId: ThreadId.make(controlOwner),
            controlOwnerLabel: (this.threadLabels.get(controlOwner) ?? "Agent").slice(0, 512),
          }
        : {}),
      availability: this.correctedAvailability(state.availability),
      health: this.backendHealth,
      capabilities: this.backendCapabilities,
      lastError: state.reportedError ?? state.lastError,
    };
  }

  /**
   * The last availability read, corrected by live backend health. The cached
   * value is whatever the last successful query said, so without this a panel
   * keeps being told the desktop is available while the supervision loop is
   * still trying to get it back. Only a claim of `available` is overridden:
   * anything already blocked carries its own, better explanation.
   */
  private correctedAvailability(availability: ComputerAvailability): ComputerAvailability {
    // A backend nobody has asked to connect is not disconnected, it is idle,
    // and health says "unavailable" for both.
    if (!this.backendEngaged) return availability;
    if (this.backendHealth.status === "connected" || availability.kind !== "available") {
      return availability;
    }
    return {
      kind: "backend-unavailable",
      message: healthUnavailableMessage(this.backendHealth),
    };
  }

  private isStreamWanted(epoch: number): boolean {
    return (
      !this.disposed &&
      this.streamDesired &&
      this.streamEpoch === epoch &&
      this.transport.streamSubscriberCount(this.computerId) > 0
    );
  }

  private recordError(error: unknown): Effect.Effect<void> {
    return Effect.sync(() => {
      const message = clampComputerMessage(
        errorMessage(error),
        "The computer backend reported an error without a message.",
      );
      for (const state of this.threads.values()) state.reportedError = message;
      // Written without a publish, a stream attach failure never reached the
      // panel it explains. Debounced, because this can fire per frame or per
      // call during an outage.
      if (this.threads.size === 0 || this.errorRepublishTimer !== undefined) return;
      this.errorRepublishTimer = this.runFork(
        Effect.sleep(COMPUTER_ERROR_REPUBLISH_DEBOUNCE_MS).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              this.errorRepublishTimer = undefined;
              return Effect.forEach(
                [...this.threads.keys()],
                (threadId) => this.publish(threadId),
                {
                  concurrency: "unbounded",
                  discard: true,
                },
              );
            }),
          ),
        ),
      );
    });
  }

  /** Observers read these through `events`; a shut-down hub drops them. */
  private emit(event: ComputerEvent): void {
    PubSub.publishUnsafe(this.eventHub, event);
  }
}

/**
 * The default travel measurement: decode both captures and correlate them. Both
 * halves already answer with undefined for anything they cannot handle, so a
 * capture in a format this does not decode costs the measurement, not the
 * scroll.
 */
function measureScrollTravelFromPng(
  before: Uint8Array,
  after: Uint8Array,
): Effect.Effect<number | undefined> {
  return Effect.map(
    Effect.all([decodePngLuma(before), decodePngLuma(after)], { concurrency: 2 }),
    ([decodedBefore, decodedAfter]) =>
      decodedBefore && decodedAfter
        ? estimateVerticalTravel(decodedBefore, decodedAfter)
        : undefined,
  );
}

/** Scroll telemetry is a reading, not a measurement instrument: two decimals is all it means. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Whether a `waitForSettle` failure means this backend can never answer it.
 * Only the two name-resolution refusals count: a driver older than the
 * observer revision reports "Unknown tool: …", and a desktop host whose
 * allowlist predates it answers "Unsupported computer host request." Neither
 * can change for the backend's life, so the refusal is cached. Anything else
 * — a stale window id, a retired generation, a transport failure — is a
 * transient miss this one action falls back from and the next may retry.
 */
function settlePermanentlyUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message.startsWith("Unknown tool:") || message === "Unsupported computer host request.";
}

function windowIdSet(windows: readonly ComputerWindow[]): ReadonlySet<string> {
  return new Set(windows.map((window) => window.id));
}

/** Rectangle intersection in the desktop's global coordinate space. */
function rectsOverlap(first: ComputerRect, second: ComputerRect): boolean {
  return (
    first.x < second.x + second.width &&
    second.x < first.x + first.width &&
    first.y < second.y + second.height &&
    second.y < first.y + first.height
  );
}

/** Front-to-back: a window with a stacking index sorts before one without. */
function byStackingIndex(first: ComputerWindow, second: ComputerWindow): number {
  return (
    (first.stackingIndex ?? Number.POSITIVE_INFINITY) -
    (second.stackingIndex ?? Number.POSITIVE_INFINITY)
  );
}

/**
 * The caller as an agent thread, or undefined for desktop input that belongs to
 * no thread — the human at the computer pane. Attribution and the desktop lease
 * must agree on who that is, so both read it here.
 */
function agentThreadId(threadId: string | undefined): string | undefined {
  const trimmed = threadId?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Why a healthy-looking availability is being withheld. The failure text comes
 * from the display server, so the whole message is clamped rather than only the
 * part this composes.
 */
function healthUnavailableMessage(health: ComputerHealth): string {
  const reason =
    health.status === "reconnecting"
      ? "Reconnecting to the desktop."
      : "The desktop backend is not connected.";
  return clampComputerMessage(
    health.lastFailure ? `${reason} Last failure: ${health.lastFailure.message}` : reason,
    reason,
  );
}

function windowNotFoundError(windowId: string): ComputerTargetError {
  return new ComputerTargetError({
    code: "computer_target_not_found",
    message:
      `No desktop window has id ${JSON.stringify(windowId)}. ` +
      "Call computer_list_windows for the current window ids.",
    notFound: true,
  });
}

/**
 * Refusal for an app-named menu target the running inventory does not know.
 * The name may be a bundle id or a display name, so the message names both
 * spellings the caller can check against computer_list_apps.
 */
function menuAppNotFoundError(app: string): ComputerTargetError {
  return new ComputerTargetError({
    code: "computer_target_not_found",
    message:
      `No running application matches ${JSON.stringify(app)}. ` +
      "Call computer_list_apps for the running apps and their pids, then name one by app or pid.",
    notFound: true,
  });
}

/**
 * The raise/focus target for a control resolved through the accessibility tree.
 * The point comes along so a failed raise is still checked for occlusion:
 * nothing consulted the stacking order while matching the label, and the click
 * that follows is as misroutable as any other.
 */
function semanticPointTarget(resolved: ComputerResolvedTarget): PreparedTarget {
  return {
    point: resolved.point,
    ...(resolved.node.windowId ? { windowId: resolved.node.windowId } : {}),
  };
}

/**
 * Refusal for a scoped action whose window is covered at the point and could
 * not be raised out from under the windows covering it.
 *
 * Refusing beats warning. The input would land in another application, and a
 * warning read after the fact cannot undo a click that already fired. The
 * message names what is in the way and both ways out, so the next call is a
 * correct one rather than a retry.
 */
function occludedTargetError(
  windowId: string,
  point: ComputerPoint,
  covering: readonly ComputerWindow[],
  reason: string,
): ComputerTargetError {
  const blockers = covering
    .slice(0, 4)
    .map((window) => `${JSON.stringify(window.title || window.id)} (${window.id})`)
    .join(", ");
  return new ComputerTargetError({
    code: "computer_target_occluded",
    message:
      `Window ${JSON.stringify(windowId)} is covered at (${point.x}, ${point.y}) by ${blockers}, ` +
      `and this desktop could not raise it: ${reason}. The input would go to the covering window. ` +
      "Aim at a part of the target window that nothing covers, or move the covering window out of " +
      "the way first; or drop window_id to act on whatever is topmost at that point.",
  });
}

/**
 * Refusal for a scoped pointer action the desktop declined to deliver.
 *
 * A coordinate is validated against the window's frame, which includes the
 * invisible resize and shadow margins around it, so a point can sit inside
 * those bounds and still be outside the region the window accepts input in.
 * The window may equally have closed since it was listed. Either way the
 * remedy is the same, and it is not retrying the identical coordinate.
 */
function refusedInjectionError(
  action: string,
  windowId: string,
  point: ComputerPoint,
): ComputerTargetError {
  return new ComputerTargetError({
    code: "computer_target_refused",
    message:
      `The desktop refused to deliver ${action} to window ${JSON.stringify(windowId)} at ` +
      `(${point.x}, ${point.y}), so no input was sent. The window is not accepting input at that ` +
      "point: a window's bounds include invisible resize and shadow margins, and the window may " +
      "also have closed since it was listed. Aim nearer the middle of the control, target it by " +
      "label instead of a coordinate, or drop window_id to act on whatever is topmost there.",
  });
}

function tripleClickUnsupportedError(): ComputerBackendError {
  return new ComputerBackendError({
    message:
      "This desktop backend cannot send a triple click. Select the line another way — " +
      "click at its start and shift-click at its end, or use the application's own " +
      "select-all shortcut with computer_press_key.",
  });
}

/**
 * The click combinations the driver has no dispatch for at all — a middle
 * button, or a right button pressed more than once. Named in the refusal so
 * the model can pick a supported gesture instead of retrying.
 */
function clickGestureUnsupportedError(
  button: "right" | "middle",
  count: 1 | 2 | 3,
): ComputerBackendError {
  return new ComputerBackendError({
    message:
      `This desktop backend cannot send a ${button} click with count ${count}. ` +
      "Supported gestures are a left click with count 1-3 and a single right click.",
  });
}

function activationUnsupportedError(): ComputerBackendError {
  return new ComputerBackendError({
    message:
      "This desktop backend cannot bring a window forward. Ask the user to click the window " +
      "they want in front, or aim the action at it with window_id instead.",
  });
}

function clipboardUnsupportedError(): ComputerBackendError {
  return new ComputerBackendError({
    message: "This computer backend does not support clipboard access.",
  });
}

function hasCoordinates(target: ComputerTarget): target is ComputerTarget & ComputerPoint {
  return typeof target.x === "number" && typeof target.y === "number";
}

/** Fields that only the accessibility tree can resolve. */
function hasLabelFields(target: ComputerTarget): boolean {
  return target.label !== undefined || target.role !== undefined;
}

function hasSemanticFields(target: ComputerTarget): boolean {
  return hasLabelFields(target) || target.windowId !== undefined;
}

/**
 * Bounds one enable-path wait. Fails past the timeout while leaving the
 * awaited fiber alone: the caller fails with the in-memory gate still held,
 * which is the fail-closed outcome the enable path depends on.
 */
function withControlEnableTimeout<A, E>(
  fiber: Fiber.Fiber<A, E> | undefined,
): Effect.Effect<A | undefined, E | ComputerBackendError> {
  if (fiber === undefined) return Effect.succeed(undefined);
  return Fiber.join(fiber).pipe(
    Effect.timeoutOrElse({
      duration: COMPUTER_CONTROL_ENABLE_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(
          new ComputerBackendError({
            message:
              "Enabling computer control timed out; control stays disabled for this conversation.",
          }),
        ),
    }),
  );
}

/**
 * The disable/removal/dispose side of the same bound: a wedged native call
 * wedges the operation tail, and without a deadline every teardown that
 * waits on it hangs forever — the in-memory gates are already held, so the
 * bounded wait can only lose cleanup confirmation, never authority. Only the
 * wait is bounded: the cleanup runs detached and still lands if it is late.
 */
function withControlTeardownTimeout<A, E>(
  action: Effect.Effect<A, E>,
): Effect.Effect<A, E | ComputerBackendError> {
  return Effect.flatMap(Effect.forkDetach(action), Fiber.join).pipe(
    Effect.timeoutOrElse({
      duration: COMPUTER_CONTROL_ENABLE_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(
          new ComputerBackendError({
            message:
              "Computer control teardown timed out waiting on a wedged operation; the in-memory gate stays held.",
          }),
        ),
    }),
  );
}
