// @effect-diagnostics nodeBuiltinImport:off -- the fixture writes and signals a real fake-driver executable and listens for its event pushes.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import {
  CUA_DRIVER_VERSION,
  CUA_NATIVE_REVISION,
  type CuaReply,
  cuaRequest,
} from "@spiritdevs/shared/cuaDriverProtocol";
import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";

import {
  type CuaCursorStyle,
  type CuaDriverHost,
  type CuaDriverHostOptions,
  CuaHostError,
  makeCuaDriverHost,
} from "../CuaDriverHost.ts";

export const CAPABILITY = "isolated-fixture-authority-00000000000000";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const DriverEvent = Schema.Struct({
  event: Schema.String,
  pid: Schema.Number,
  time: Schema.Number,
});
export type DriverEvent = typeof DriverEvent.Type;
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(DriverEvent));

/** What the fake driver does; mirrors Synara's fixture switches one for one. */
export interface DriverBehavior {
  readonly cleanup?: "incomplete" | "wrong-pid" | "missing-admission";
  readonly interruptCleanup?: "incomplete" | "wrong-pid" | "missing-admission" | "once-incomplete";
  readonly unpatched?: boolean;
  readonly reportedRevision?: number;
  readonly browserInputControl?: unknown;
  readonly metadataPidOffset?: number;
  readonly metadataDelayMs?: number;
  readonly failAction?: boolean;
  readonly actionResult?: Record<string, unknown>;
  readonly cursorUnavailable?: boolean;
  readonly logCursorState?: boolean;
  readonly cursorEnableFailures?: number;
  readonly cursorHideFailures?: number;
  readonly crash?: boolean;
  readonly sessionDeathOnce?: boolean;
  readonly sessionDeathTransport?: boolean;
  /** Logs `session:`/`open_session:` lines for the label each call rides. */
  readonly logSessions?: boolean;
  readonly browserRefusal?: boolean;
  readonly browserHang?: boolean;
  readonly browserCleanupUnconfirmed?: boolean;
  readonly browserObservations?: boolean;
  readonly inputDelayMs?: number;
  readonly delayBrowserObservation?: boolean;
  readonly delayObservation?: boolean;
  readonly delayListWindowsMs?: number;
  readonly hangSession?: boolean;
  readonly dropCancel?: boolean;
  readonly listWindows?: ReadonlyArray<Record<string, unknown>>;
}

export interface FixtureOptions
  extends
    DriverBehavior,
    Partial<
      Pick<
        CuaDriverHostOptions,
        | "checkPermissions"
        | "releaseHeldInput"
        | "inputMonitorState"
        | "activateInputMonitor"
        | "onInputMonitorArmedChange"
        | "frameTap"
        | "shield"
        | "startupTimeoutMs"
        | "nativeRevision"
        | "ownPids"
        | "warmOnFirstTouch"
        | "linuxAdmission"
        | "normalizeOverview"
      >
    > {
  readonly capability?: string;
  readonly platform?: "darwin" | "linux";
  readonly cursorStyle?: () => CuaCursorStyle | null | undefined;
  /** Leave the binary out, as an unprovisioned checkout would. */
  readonly missingBinary?: boolean;
}

export interface SendOptions {
  readonly mutation?: boolean;
  readonly timeoutMs?: number;
  /** Completing this effect cancels the request. */
  readonly cancel?: Effect.Effect<void>;
}

export interface Fixture {
  readonly host: CuaDriverHost;
  /** Closes the host's scope without calling `dispose` first, as a layer teardown does. */
  readonly closeHostScope: Effect.Effect<void>;
  readonly endpoint: string;
  readonly binary: string;
  /** Every event the fake drivers wrote so far; empty when none started. */
  readonly events: Effect.Effect<ReadonlyArray<DriverEvent>>;
  readonly eventNames: Effect.Effect<ReadonlyArray<string>>;
  readonly count: (event: string) => Effect.Effect<number>;
  /** Waits until the drivers wrote `event` at least `times` times. Push-driven, never polled. */
  readonly waitForEvent: (
    event: string | ((name: string) => boolean),
    times?: number,
  ) => Effect.Effect<ReadonlyArray<DriverEvent>>;
  /** One authenticated host request; the body may override `capability`. */
  readonly send: <T = CuaReply>(
    body: Record<string, unknown>,
    options?: SendOptions,
  ) => Effect.Effect<T, CuaHostError>;
  /** Log messages the host wrote, in order. */
  readonly logs: ReadonlyArray<string>;
  /** Waits until the host logged a message containing `text`. Push-driven, never polled. */
  readonly waitForLog: (text: string) => Effect.Effect<void>;
  /** Parsed JSON log lines carrying `event`. */
  readonly logEvents: (event: string) => ReadonlyArray<Record<string, unknown>>;
  /** Moves the host's wall clock forward, e.g. past the Escape cooldown, without sleeping. */
  readonly advanceClock: (ms: number) => void;
}

/**
 * The Cua driver the host talks to, as a real executable: a node script that
 * speaks the driver socket protocol, appends each event to `events.jsonl` and
 * pushes a wake-up to the test's event socket.
 */
const driverScript = (log: string, events: string, behavior: Record<string, unknown>) => `#!${
  // oxlint-disable-next-line pathway/no-global-process-runtime -- the fake driver runs under this test's own node binary.
  process.execPath
}
const net=require('node:net'),fs=require('node:fs');
const log=${encodeJson(log)}, options=${encodeJson(behavior)};
const push=net.createConnection(${encodeJson(events)}); push.on('error',()=>{});
const write=event=>{fs.appendFileSync(log,JSON.stringify({event,pid:process.pid,time:Date.now()})+'\\n');push.write('\\n');};
write('start');
if(!options.unpatched){
  if(!process.argv.includes('--compact-cursor')) throw new Error('Missing compact cursor profile');
  if(process.argv[process.argv.indexOf('--idle-hide-ms')+1]!=='60000') throw new Error('Missing cursor idle deadline');
}
if(options.unpatched&&(process.argv.includes('--compact-cursor')||process.argv.includes('--idle-hide-ms'))) throw new Error('Upstream driver cannot parse Pathway cursor flags');
const socket=process.argv[process.argv.indexOf('--socket')+1];
let action, timer, inputEpoch=0, interruptions=0, browserCleanupPending=false, cursorEnables=0, cursorHides=0;
net.createServer(s=>{
  const reply=result=>s.end(JSON.stringify({ok:true,result})+'\\n');
  s.once('data',b=>{
    const r=JSON.parse(b.toString());
    if(options.logSessions&&r.method==='call'&&r.args&&typeof r.args.session==='string') write('session:'+r.args.session+':'+r.name);
    if(r.method==='metadata') setTimeout(()=>reply({driver_version:${encodeJson(CUA_DRIVER_VERSION)},pathway_native_revision:options.reportedRevision??(options.unpatched?undefined:${CUA_NATIVE_REVISION}),pathway_browser_input_control:options.browserInputControl,embedded:true,pid:process.pid+(options.metadataPidOffset??0)}),options.metadataDelayMs??0);
    else if(r.method==='interrupt_input') {
      write('interrupt');
      if(r.args.expected_pid!==process.pid) throw new Error('Wrong interrupt generation');
      inputEpoch++; interruptions++;
      clearTimeout(timer);
      if(action) { write('release'); action.end(JSON.stringify({ok:false,error:'interrupted'})+'\\n'); action=undefined; }
      const incomplete=browserCleanupPending||options.interruptCleanup==='incomplete'||(options.interruptCleanup==='once-incomplete'&&interruptions===1);
      setTimeout(()=>{
        write('interrupt-ack');
        reply({pid:process.pid+(options.interruptCleanup==='wrong-pid'?1:0),input_interrupted:true,input_admission_open:options.interruptCleanup==='missing-admission'?undefined:!incomplete,cleanup_complete:!incomplete,pending_input:incomplete?1:0,input_epoch:inputEpoch});
      },30);
    }
    else if(r.method==='cancel_input') {
      write('cancel');
      if(options.dropCancel) { s.destroy(); return; }
      if(r.args.expected_pid!==process.pid) throw new Error('Wrong generation');
      clearTimeout(timer);
      if(action) { write('release'); action.end(JSON.stringify({ok:false,error:'cancelled'})+'\\n'); action=undefined; }
      setTimeout(()=>{
        write('cleanup-ack');
        reply({pid:process.pid+(options.cleanup==='wrong-pid'?1:0),input_admission_closed:options.cleanup==='missing-admission'?undefined:true,cleanup_complete:!browserCleanupPending&&options.cleanup!=='incomplete',pending_input:browserCleanupPending||options.cleanup==='incomplete'?1:0});
      },30);
    }
    else if(options.sessionDeathOnce && r.method==='call' && r.args && r.args.session && r.name!=='start_session' && r.name!=='set_agent_cursor_motion' && r.name!=='set_agent_cursor_style' && r.name!=='set_agent_cursor_enabled' && r.name!=='get_agent_cursor_state' && !fs.existsSync(options.deathFlag)) { fs.writeFileSync(options.deathFlag, '1'); reply({isError:true, content:[{type:'text', text:"session '"+r.args.session+"' has ended; tool call '"+r.name+"' was rejected. Call start_session with this id to revive it before issuing further actions, or use a new session id."}], structuredContent:{effect:'not-dispatched'}}); }
    else if(options.sessionDeathTransport && r.method==='call' && r.args && r.args.session && r.name!=='start_session' && r.name!=='set_agent_cursor_motion' && r.name!=='set_agent_cursor_style' && r.name!=='set_agent_cursor_enabled' && r.name!=='get_agent_cursor_state' && !fs.existsSync(options.deathFlag)) { fs.writeFileSync(options.deathFlag, '1'); s.end(JSON.stringify({ok:false,error:"session '"+r.args.session+"' has ended; tool call '"+r.name+"' was rejected. Call start_session with this id to revive it before issuing further actions, or use a new session id.",effect:'not-dispatched'})+'\\n'); }
    else if(r.name==='type_text') {
      if(!options.unpatched&&r.expected_input_epoch!==inputEpoch) { reply({isError:true,structuredContent:{effect:'refused',code:'input_admission_closed'}}); return; }
      write('dispatch'); action=s;
      if(options.crash) { write('crash'); process.exit(1); }
      else if(options.failAction) s.destroy();
      else timer=setTimeout(()=>{write('effect');reply({});action=undefined},options.inputDelayMs??10000);
    }
    else if(options.hangSession && r.name==='start_session' && !fs.existsSync(options.deathFlag)) { fs.writeFileSync(options.deathFlag,'1'); write('session-hang'); }
    else if(r.name==='set_agent_cursor_motion') { write('motion-'+r.args.glide_duration_ms+'-'+r.args.dwell_after_click_ms); reply({}); }
    else if(r.name==='set_agent_cursor_style') { write('style:'+JSON.stringify(r.args)); reply({}); }
    else if(r.name==='set_agent_cursor_enabled') {
      if(options.logCursorState) write('cursor-enabled:'+r.args.enabled+':'+r.args.session);
      const failed=r.args.enabled?cursorEnables++<(options.cursorEnableFailures??0):cursorHides++<(options.cursorHideFailures??0);
      reply(failed?{isError:true}:{});
    }
    else if(r.name==='get_agent_cursor_state') {
      if(options.logCursorState) write('cursor-state:'+r.args.session);
      reply(options.cursorUnavailable?{isError:true,content:[{type:'text',text:'private overlay error'}]}:{structuredContent:{session:r.args.session,enabled:true,position:{x:10,y:20},motion:{idle_hide_ms:60000},overlay_ready:true,render_visible:true,overlay_scope:'main_display'}});
    }
    else if(options.browserInputControl===1&&['clipboard_read','clipboard_write','kill_app','move_cursor'].includes(r.name)) {
      if(r.expected_input_epoch!==inputEpoch) { reply({isError:true,structuredContent:{effect:'refused',code:'input_admission_closed'}}); return; }
      write('permitted-native:'+r.name); reply({});
    }
    else if(r.name==='press_key') { if(!options.unpatched&&r.expected_input_epoch!==inputEpoch) { reply({isError:true,structuredContent:{effect:'refused',code:'input_admission_closed'}}); return; } write('key'); write('observation-budget-'+process.env.PATHWAY_CUA_FOREGROUND_OBSERVATION_MS); reply(options.actionResult??{}); }
    else if(r.name==='get_window_state' && !r.args?.empty) { write('observe'); setTimeout(()=>reply({structuredContent:{elements:r.args?.fixture_usable?[{role:"AXWindow"}]:[],window_is_on_screen:r.args?.fixture_usable===true,window_on_current_space:r.args?.fixture_usable===true,degraded:r.args?.fixture_degraded,screenshot_frame_valid:r.args?.fixture_stale!==true,pid:r.args?.pid,window_id:r.args?.fixture_wrong_window?99999:r.args?.window_id}}),options.delayObservation?60:0); }
    else if(r.name==='get_desktop_state') reply({content:[{type:'image',data:'fixture-image'}]});
    else if(r.name==='list_windows') { write('list-windows'); setTimeout(()=>{reply({structuredContent:{windows:options.listWindows||[]}});if(options.delayListWindowsMs) write('list-windows-replied');},options.delayListWindowsMs??0); }
    else if(r.method==='session_begin') { write('session-begin:'+r.session_id); s.write(JSON.stringify({ok:true,result:{session_begin:true}})+'\\n'); }
    else if((r.name==='start_session'||r.name==='end_session')&&r.session_id) { write(r.name+':'+r.args.session+':'+r.session_id); reply({}); }
    else if(options.logSessions&&(r.name==='start_session'||r.name==='end_session')) { write('open_session:'+r.name+':'+r.args.session); reply({}); }
    else if(r.name==='start_session'||r.name==='end_session') { reply({}); }
    else if(r.name&&(r.name.indexOf('browser_')===0||r.name==='get_browser_state')) {
      write('browser:'+r.name+':'+(r.args&&r.args.session)+':'+(r.session_id||'-'));
      if(r.name.indexOf('browser_')===0&&(!options.unpatched||options.browserInputControl===1)&&r.expected_input_epoch!==inputEpoch) { reply({isError:true,structuredContent:{effect:'refused',code:'input_admission_closed'}}); return; }
      if(options.browserObservations&&r.name==='get_browser_state') {
        if(r.args?.target_id) {
          write('browser-observe');
          const data={status:'ok',mode:r.args.fixture_bind_only?'bind':'snapshot',target_id:r.args.fixture_wrong_target?'wrong-target':r.args.target_id,tab_id:r.args.tab_id,refs:[]};
          if(r.args.snapshot_format==='semantic_v2') data.snapshot={id:'p1'}; else data.snapshot_id='p1';
          setTimeout(()=>reply({structuredContent:data}),options.delayBrowserObservation?60:0);
        } else reply({structuredContent:{status:'ok',mode:'bind',binding_quality:'exact',mutation_allowed:true,target_id:r.args.fixture_target_id||'target-'+r.args.pid+'-'+r.args.window_id,tabs:[]}});
      }
      else if(options.browserHang&&r.name==='browser_type') { write('browser-dispatch'); action=s; timer=setTimeout(()=>{write('browser-effect'); reply({}); action=undefined},options.inputDelayMs??10000); }
      else if(options.browserCleanupUnconfirmed&&r.name==='browser_type') { browserCleanupPending=true; reply({isError:true,structuredContent:{input_cleanup_unconfirmed:true,effect:'unverifiable'}}); }
      else reply(options.browserRefusal?{structuredContent:{status:'refused',refusal:{code:'browser_requires_setup'}},content:[{type:'text',text:'refused (browser_requires_setup)'}]}:{});
    }
    else reply({});
  });
  s.on('error',()=>{});
}).listen(socket);
let retiring=false;
function retire(){if(retiring)return;retiring=true;write('retiring');setTimeout(()=>{write('exit');process.exit(0)},150)}
process.on('SIGTERM',retire);
process.stdin.resume(); process.stdin.on('end',retire);
`;

const logText = (message: unknown) =>
  Array.isArray(message) ? message.map(String).join(" ") : String(message);
const decodeLogLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/**
 * A host over a real fake driver, torn down with the test's scope: the host is
 * disposed, then every fake driver the test started is killed by the pid it
 * recorded at start.
 */
export const makeFixture = Effect.fn("makeFixture")(function* (options: FixtureOptions = {}) {
  const directory = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-cua-host-test-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
  const log = NodePath.join(directory, "events.jsonl");
  const binary = NodePath.join(directory, "driver");
  const pushSocket = NodePath.join(directory, "events.sock");

  const wakers = new Set<() => void>();
  const wake = () => {
    for (const waker of wakers) waker();
  };
  const pushServer = NodeNet.createServer((socket) => {
    socket.on("data", wake);
    socket.on("close", wake);
    socket.on("error", () => undefined);
  });
  yield* Effect.callback<void>((resume) => {
    pushServer.listen(pushSocket, () => resume(Effect.void));
  });

  const readEvents = (): Promise<ReadonlyArray<DriverEvent>> =>
    NodeFSP.readFile(log, "utf8").then(
      (text) =>
        text
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => decodeEvent(line)),
      () => [],
    );
  const events = Effect.promise(readEvents);
  const behavior = { ...options, deathFlag: NodePath.join(directory, "session-died") };
  if (!options.missingBinary) {
    yield* Effect.promise(() =>
      NodeFSP.writeFile(binary, driverScript(log, pushSocket, behavior), { mode: 0o755 }),
    );
  }
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      pushServer.close();
      // These are fake executables this test started, with no OS input API.
      // A deliberately invalid cleanup acknowledgement leaves them alive.
      for (const event of yield* events) {
        if (event.event !== "start") continue;
        // An already exited driver has nothing left to kill.
        yield* Effect.ignore(Effect.try(() => process.kill(event.pid, "SIGKILL")));
      }
    }),
  );

  const logs: string[] = [];
  const logWakers = new Set<(line: string) => void>();
  const capture = Logger.make(({ message }) => {
    const line = logText(message);
    logs.push(line);
    for (const waker of logWakers) waker(line);
  });
  const waitForLog = (text: string) =>
    Effect.callback<void>((resume) => {
      if (logs.some((line) => line.includes(text))) return resume(Effect.void);
      const waker = (line: string) => {
        if (!line.includes(text)) return;
        logWakers.delete(waker);
        resume(Effect.void);
      };
      logWakers.add(waker);
      return Effect.sync(() => {
        logWakers.delete(waker);
      });
    }).pipe(
      Effect.timeoutOrElse({
        duration: 5_000,
        orElse: () =>
          Effect.die(new Error(`timed out waiting for log ${text}; saw ${logs.join("\n")}`)),
      }),
    );
  const base = yield* Clock.Clock;
  let offset = 0;
  const skewed: Clock.Clock = {
    currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe() + offset,
    currentTimeMillis: Effect.sync(() => base.currentTimeMillisUnsafe() + offset),
    currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe() + BigInt(offset) * 1_000_000n,
    currentTimeNanos: Effect.sync(
      () => base.currentTimeNanosUnsafe() + BigInt(offset) * 1_000_000n,
    ),
    monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: base.monotonicTimeNanos,
    sleep: (duration) => base.sleep(duration),
  };

  // The host gets its own scope so its disposal can be checked before the
  // fake drivers are killed.
  const hostScope = yield* Scope.make();
  const host = yield* makeCuaDriverHost({
    binaryPath: binary,
    bundleId: "fixture",
    capability: options.capability ?? CAPABILITY,
    setup: Effect.void,
    ...(options.checkPermissions ? { checkPermissions: options.checkPermissions } : {}),
    ...(options.releaseHeldInput ? { releaseHeldInput: options.releaseHeldInput } : {}),
    ...(options.inputMonitorState ? { inputMonitorState: options.inputMonitorState } : {}),
    ...(options.activateInputMonitor ? { activateInputMonitor: options.activateInputMonitor } : {}),
    ...(options.onInputMonitorArmedChange
      ? { onInputMonitorArmedChange: options.onInputMonitorArmedChange }
      : {}),
    ...(options.frameTap ? { frameTap: options.frameTap } : {}),
    ...(options.shield ? { shield: options.shield } : {}),
    ...(options.startupTimeoutMs ? { startupTimeoutMs: options.startupTimeoutMs } : {}),
    ...(options.nativeRevision !== undefined ? { nativeRevision: options.nativeRevision } : {}),
    ...(options.ownPids ? { ownPids: options.ownPids } : {}),
    ...(options.cursorStyle ? { cursorStyle: options.cursorStyle } : {}),
    ...(options.warmOnFirstTouch ? { warmOnFirstTouch: true } : {}),
    ...(options.linuxAdmission ? { linuxAdmission: options.linuxAdmission } : {}),
    ...(options.normalizeOverview ? { normalizeOverview: options.normalizeOverview } : {}),
  }).pipe(
    Scope.provide(hostScope),
    Effect.provideService(HostProcessPlatform, options.platform ?? "darwin"),
    Effect.provideService(Clock.Clock, skewed),
    Effect.provideService(Logger.CurrentLoggers, new Set([capture])),
    Effect.provide(NodeServices.layer),
  );
  // A closed host scope already disposed the host, and its runtime is gone.
  let hostScopeClosed = false;
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (hostScopeClosed) return;
      const disposed = yield* Effect.exit(host.dispose);
      yield* Scope.close(hostScope, disposed);
      const expectsFailure =
        options.cleanup !== undefined ||
        options.crash === true ||
        options.browserCleanupUnconfirmed === true;
      if (disposed._tag === "Failure" && !expectsFailure)
        return yield* Effect.die(new Error(`host dispose failed: ${String(disposed.cause)}`));
    }),
  );
  const endpoint = yield* host.listen;

  const matches = (event: string | ((name: string) => boolean)) =>
    typeof event === "string" ? (name: string) => name === event : event;
  const waitForEvent = (event: string | ((name: string) => boolean), times = 1) => {
    const match = matches(event);
    const satisfied = (rows: ReadonlyArray<DriverEvent>) =>
      rows.filter((row) => match(row.event)).length >= times;
    return Effect.callback<ReadonlyArray<DriverEvent>>((resume) => {
      let checking = false;
      let again = false;
      const check = () => {
        if (checking) {
          again = true;
          return;
        }
        checking = true;
        void readEvents().then((rows) => {
          checking = false;
          if (satisfied(rows)) {
            wakers.delete(check);
            resume(Effect.succeed(rows));
          } else if (again) {
            again = false;
            check();
          }
        });
      };
      wakers.add(check);
      check();
      return Effect.sync(() => {
        wakers.delete(check);
      });
    }).pipe(
      Effect.timeoutOrElse({
        duration: 5_000,
        orElse: () =>
          Effect.flatMap(events, (rows) =>
            Effect.die(
              new Error(
                `Timed out waiting for driver event ${String(event)}; saw ${rows.map((row) => row.event).join(", ")}`,
              ),
            ),
          ),
      }),
    );
  };

  const send = <T = CuaReply>(body: Record<string, unknown>, sendOptions: SendOptions = {}) =>
    cuaRequest<T>(
      endpoint,
      { capability: options.capability ?? CAPABILITY, ...body },
      sendOptions,
    ).pipe(Effect.mapError((error) => new CuaHostError({ message: error.message })));

  return {
    host,
    closeHostScope: Effect.suspend(() => {
      hostScopeClosed = true;
      return Scope.close(hostScope, Exit.void);
    }),
    endpoint,
    binary,
    events,
    eventNames: Effect.map(events, (rows) => rows.map((row) => row.event)),
    count: (event: string) =>
      Effect.map(events, (rows) => rows.filter((row) => row.event === event).length),
    waitForEvent,
    waitForLog,
    send,
    logs,
    logEvents: (event: string) =>
      logs.flatMap((line) => {
        const parsed = decodeLogLine(line);
        return parsed._tag === "Some" && parsed.value.event === event ? [parsed.value] : [];
      }),
    advanceClock: (ms: number) => {
      offset += ms;
    },
  } satisfies Fixture;
});

export type { CuaDriverHost };
