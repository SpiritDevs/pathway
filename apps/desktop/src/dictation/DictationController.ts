// @effect-diagnostics nodeBuiltinImport:off -- Owns temporary desktop recording files and native lifetimes.
// @effect-diagnostics globalTimers:off -- Recording limits and idle model eviction are lifecycle deadlines.
// @effect-diagnostics globalDate:off -- Dictation history records wall-clock timestamps.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  defaultDictationPreferences,
  dictationDictionaryError,
  type DictationCommand,
  type DictationState,
  type DictationPreferences,
  type DictationHistoryEntry,
  type DictationModelId,
  type DictationMicrophone,
} from "@spiritdevs/contracts/dictation";
import type { DictationModels } from "./DictationModels.ts";
import type { DictationStorage } from "./DictationStorage.ts";
import {
  acceptableDictationCleanup,
  applyDictationDictionary,
  cleanRecognizedText,
  dictationModelHints,
} from "./textProcessing.ts";
import { advanceDictationShortcut, emptyDictationShortcutState } from "./shortcutState.ts";

export interface DictationNativePort {
  permissions(
    request: boolean,
    permission?: "microphone" | "accessibility",
  ): Promise<{
    microphone: "unknown" | "granted" | "denied";
    accessibility: "unknown" | "granted" | "denied";
  }>;
  microphones(): Promise<readonly DictationMicrophone[]>;
  configure(shortcut: DictationPreferences["shortcut"], enabled: boolean): Promise<void>;
  start(id: string, audioPath: string, deviceId: string): Promise<void>;
  stop(id: string): Promise<{ durationMs: number }>;
  cancel(id: string): Promise<void>;
  insert(text: string): Promise<{ status: "inserted" | "manual" | "unconfirmed"; reason?: string }>;
  close(): void | Promise<void>;
}
export interface DictationInferencePort {
  prepare(input: {
    modelId: DictationModelId;
    cleanup: boolean;
    signal: AbortSignal;
  }): Promise<void>;
  transcribeWithLanguage(input: {
    audioPath: string;
    modelId: DictationModelId;
    language: string;
    terms: readonly string[];
    signal: AbortSignal;
  }): Promise<{ text: string; language?: string }>;
  cleanup(input: {
    requireLoaded: boolean;
    text: string;
    terms: readonly string[];
    language: string;
    signal: AbortSignal;
  }): Promise<string>;
  unload(): void | Promise<void>;
}
interface Session {
  id: string;
  accountId: string;
  audioPath: string;
  abort: AbortController;
  preferences: DictationPreferences;
  dictionary: DictationState["dictionary"];
  mode: DictationState["mode"];
  durationMs: number;
  interrupted: boolean;
}
const busy = (phase: DictationState["phase"]) =>
  phase === "starting" || phase === "recording" || phase === "processing";

export interface DictationControllerOptions {
  platform: string;
  arch: string;
  nativeAvailable: boolean;
  temporaryDirectory: string;
  storage: DictationStorage;
  models: Pick<
    DictationModels,
    "initialize" | "getStates" | "isInstalled" | "download" | "cancel" | "remove" | "dispose"
  >;
  native: DictationNativePort;
  inference: DictationInferencePort;
  onState: (state: DictationState) => void;
  onMeter: (meter: { durationMs: number; level: number; mode: DictationState["mode"] }) => void;
  copy: (text: string) => void;
  open: (page: "models" | "history" | "dictionary" | "settings") => void;
}

export class DictationController {
  private state: DictationState;
  private accountId: string | null = null;
  private session: Session | null = null;
  private shortcut = emptyDictationShortcutState();
  private accountGeneration = 0;
  private sessionGeneration = 0;
  private nativeQueue = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private limitTimer: ReturnType<typeof setTimeout> | undefined;
  private pruneTimer: ReturnType<typeof setInterval> | undefined;
  private initialization: Promise<void> | undefined;
  private disposed = false;

  private readonly options: DictationControllerOptions;
  constructor(options: DictationControllerOptions) {
    this.options = options;
    this.state = {
      supported:
        (options.platform === "darwin" && options.arch === "arm64") ||
        (options.platform === "win32" && options.arch === "x64"),
      platform: options.platform,
      authenticated: false,
      accountId: null,
      preferences: defaultDictationPreferences(options.platform),
      models: options.models.getStates(),
      microphones: [],
      microphonePermission: "unknown",
      accessibilityPermission: "unknown",
      nativeAvailable: options.nativeAvailable,
      phase: "disabled",
      mode: "hold",
      durationMs: 0,
      level: 0,
      result: null,
      error: null,
      dictionary: [],
      dictionaryConnected: false,
    };
  }

  initialize() {
    return (this.initialization ??= (async () => {
      // A process crash can leave a stopped capture behind while an engine was reading it.
      await NodeFSP.mkdir(this.options.temporaryDirectory, { recursive: true, mode: 0o700 });
      for (const file of await NodeFSP.readdir(this.options.temporaryDirectory)) {
        if (/^[\da-f-]{36}\.wav$/.test(file))
          await NodeFSP.rm(NodePath.join(this.options.temporaryDirectory, file), { force: true });
      }
      this.state = {
        ...this.state,
        preferences: await this.options.storage.preferences(this.options.platform),
      };
      await this.options.models.initialize();
      if (this.disposed) return;
      this.publish();
      this.pruneTimer = setInterval(() => {
        void this.prune().catch((error) => this.fail(error));
      }, 3_600_000);
      this.pruneTimer.unref();
    })());
  }

  getState(): DictationState {
    return { ...this.state, models: this.options.models.getStates() };
  }
  get isBackgroundEnabled() {
    return this.state.authenticated && this.state.preferences.enabled;
  }
  get isBusy() {
    return busy(this.state.phase);
  }
  modelChanged() {
    if (!this.disposed) this.publish();
  }
  private publish(patch: Partial<DictationState> = {}) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.options.onState(this.getState());
  }
  private fail(error: unknown) {
    this.publish({
      error: error instanceof Error ? error.message : "Dictation could not complete.",
    });
  }
  private queueNative<A>(operation: () => Promise<A>): Promise<A> {
    const result = this.nativeQueue.then(operation);
    this.nativeQueue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private current(session: Session) {
    return (
      this.session === session &&
      !session.abort.signal.aborted &&
      this.accountId === session.accountId &&
      !this.disposed
    );
  }
  private idlePhase(): DictationState["phase"] {
    return this.isBackgroundEnabled ? "idle" : "disabled";
  }

  async execute(command: DictationCommand): Promise<DictationState> {
    await this.initialize();
    if (this.disposed) throw new Error("Dictation has stopped.");
    if (command.type === "account") {
      await this.setAccount(command.accountId);
      return this.getState();
    }
    if (!this.accountId) throw new Error("Sign in to Pathway to use dictation.");
    switch (command.type) {
      case "preferences":
        await this.preferences(command.preferences);
        break;
      case "dictionary": {
        const error = dictationDictionaryError(command.lists);
        if (error) throw new Error(error);
        const accountId = this.accountId;
        await this.options.storage.saveDictionary(accountId, command.lists);
        if (accountId === this.accountId)
          this.publish({ dictionary: command.lists, dictionaryConnected: command.connected });
        break;
      }
      case "download":
        this.publish({ error: null });
        void this.options.models.download(command.modelId).then(
          () => this.publish(),
          (error) => {
            if (!(error instanceof Error && error.name === "AbortError")) this.fail(error);
          },
        );
        break;
      case "cancel-download":
        await this.options.models.cancel(command.modelId);
        break;
      case "remove-model":
        if (this.isBusy) throw new Error("Finish dictation before removing a model.");
        await this.options.inference.unload();
        await this.options.models.remove(command.modelId);
        if (command.modelId === this.state.preferences.speechModel)
          await this.preferences({ ...this.state.preferences, enabled: false });
        this.publish();
        break;
      case "start":
        await this.start(command.mode);
        break;
      case "stop":
        await this.stop();
        break;
      case "cancel":
        await this.cancel();
        break;
      case "dismiss":
        if (this.isBusy) break;
        this.publish({ phase: this.idlePhase(), mode: "hold", result: null, error: null });
        break;
      case "permissions":
        await this.refreshNative(
          command.action !== "refresh",
          command.action === "refresh" ? undefined : command.action,
        );
        break;
      case "refresh-devices":
        await this.refreshNative(false);
        break;
      case "copy":
        if (command.text.length > 100_000) throw new Error("The text is too long to copy.");
        this.options.copy(command.text);
        break;
      case "delete-history":
        await this.options.storage.deleteHistory(this.accountId, command.id);
        this.publish();
        break;
      case "open":
        this.options.open(command.page);
        break;
    }
    return this.getState();
  }

  async setAccount(accountId: string | null) {
    if (this.accountId === accountId) return;
    const generation = ++this.accountGeneration;
    this.accountId = accountId;
    this.publish({
      authenticated: false,
      accountId: null,
      dictionary: [],
      dictionaryConnected: false,
      result: null,
    });
    await this.cancel();
    await this.options.inference.unload();
    await this.options.native.close();
    if (generation !== this.accountGeneration) return;
    if (!accountId) {
      this.publish({ phase: "disabled" });
      return;
    }
    const dictionary = await this.options.storage.dictionary(accountId);
    if (generation !== this.accountGeneration) return;
    this.publish({
      authenticated: true,
      accountId,
      dictionary,
      phase: this.state.preferences.enabled ? "idle" : "disabled",
    });
    await this.prune();
    if (this.state.preferences.enabled)
      await this.refreshNative(false).catch((error) => this.fail(error));
  }

  private async refreshNative(request: boolean, permission?: "microphone" | "accessibility") {
    if (!this.state.supported || !this.state.nativeAvailable)
      throw new Error("Native dictation is not available in this build.");
    const accountGeneration = this.accountGeneration;
    const preferences = this.state.preferences;
    const stillCurrent = () =>
      this.accountGeneration === accountGeneration &&
      this.state.preferences === preferences &&
      this.state.authenticated;
    const permissions = await this.options.native.permissions(request, permission);
    if (!stillCurrent()) return;
    const microphones = await this.options.native.microphones();
    if (!stillCurrent()) return;
    this.publish({
      microphonePermission: permissions.microphone,
      accessibilityPermission: permissions.accessibility,
      microphones,
    });
    await this.options.native.configure(
      this.state.preferences.shortcut,
      this.isBackgroundEnabled && permissions.accessibility === "granted",
    );
  }

  private async preferences(value: DictationPreferences) {
    if (value.speechModel === "qwen-cleanup") throw new Error("Choose a speech recognition model.");
    if (
      !Number.isInteger(value.retentionDays) ||
      value.retentionDays < 0 ||
      value.retentionDays > 3650 ||
      ![-1, 0, 5, 15].includes(value.idleUnloadMinutes)
    )
      throw new Error("Choose valid retention and model memory settings.");
    if (
      value.enabled &&
      (!this.state.nativeAvailable ||
        !this.state.supported ||
        !this.options.models.isInstalled(value.speechModel))
    )
      throw new Error("Install a speech model and finish native setup before enabling dictation.");
    if (value.enabled && !this.state.preferences.enabled) {
      const generation = this.accountGeneration;
      await this.refreshNative(false);
      if (generation !== this.accountGeneration || !this.state.authenticated)
        throw new Error("Sign in to Pathway to enable dictation.");
      if (
        this.state.microphonePermission !== "granted" ||
        this.state.accessibilityPermission !== "granted"
      )
        throw new Error("Allow microphone and Accessibility access before enabling dictation.");
    }
    await this.options.storage.savePreferences(value);
    this.publish({ preferences: value });
    if (!value.enabled) {
      await this.cancel();
      await this.options.inference.unload();
      await this.options.native.close();
    } else await this.refreshNative(false);
    if (!this.isBusy) this.publish({ phase: this.idlePhase() });
    await this.prune();
    this.scheduleUnload();
  }

  async start(mode: DictationState["mode"]) {
    if (!this.accountId || !this.state.authenticated)
      throw new Error("Sign in to Pathway to dictate.");
    if (this.isBusy) return;
    if (mode !== "test" && !this.state.preferences.enabled)
      throw new Error("Enable dictation in Settings first.");
    if (!this.options.models.isInstalled(this.state.preferences.speechModel))
      throw new Error("Download a speech model first.");
    if (!this.state.nativeAvailable)
      throw new Error("Native dictation is not available in this build.");
    clearTimeout(this.idleTimer);
    const id = NodeCrypto.randomUUID();
    const session: Session = {
      id,
      accountId: this.accountId,
      audioPath: NodePath.join(this.options.temporaryDirectory, `${id}.wav`),
      abort: new AbortController(),
      preferences: { ...this.state.preferences },
      dictionary: this.state.dictionary,
      mode,
      durationMs: 0,
      interrupted: false,
    };
    this.sessionGeneration++;
    this.session = session;
    if (mode === "locked") this.shortcut = { ...emptyDictationShortcutState(), locked: true };
    this.publish({ phase: "starting", mode, durationMs: 0, level: 0, result: null, error: null });
    // Load both workers during capture; a failed preparation is retried by processing.
    void this.options.inference
      .prepare({
        modelId: session.preferences.speechModel,
        cleanup:
          session.preferences.cleanupEnabled && this.options.models.isInstalled("qwen-cleanup"),
        signal: session.abort.signal,
      })
      .catch(() => {});
    try {
      await NodeFSP.mkdir(this.options.temporaryDirectory, { recursive: true, mode: 0o700 });
      await this.queueNative(async () => {
        if (this.current(session))
          await this.options.native.start(id, session.audioPath, session.preferences.microphoneId);
      });
      if (!this.current(session) || this.state.phase !== "starting") return;
      this.publish({ phase: "recording" });
      this.limitTimer = setTimeout(() => {
        void this.stop().catch((error) => this.fail(error));
      }, 300_000);
      this.limitTimer.unref();
    } catch (error) {
      if (!this.current(session)) return;
      const cancellation = this.cancel();
      const generation = this.sessionGeneration;
      await cancellation;
      if (this.sessionGeneration === generation && this.accountId === session.accountId)
        this.publish({
          phase: "error",
          error: error instanceof Error ? error.message : "The microphone could not start.",
        });
    }
  }

  async microphoneDisconnected(id: string, durationMs: number) {
    if (this.session?.id === id) await this.stop(true, durationMs);
  }

  async nativeFailed(message: string) {
    const accountGeneration = this.accountGeneration;
    const cancellation = this.cancel();
    const generation = this.sessionGeneration;
    await cancellation;
    if (
      this.sessionGeneration === generation &&
      this.accountGeneration === accountGeneration &&
      this.isBackgroundEnabled
    )
      this.publish({ phase: "error", error: message });
  }

  meter(id: string, durationMs: number, level: number) {
    if (!this.session || this.session.id !== id || !this.current(this.session) || !this.isBusy)
      return;
    this.session.durationMs = durationMs;
    this.state = { ...this.state, durationMs, level: Math.max(0, Math.min(1, level)) };
    this.options.onMeter({ durationMs, level: this.state.level, mode: this.state.mode });
  }

  shortcutEvent(edge: "down" | "up" | "cancel", now: number) {
    if (!this.isBackgroundEnabled) return;
    if (edge !== "cancel" && this.state.phase === "processing") return;
    const next = advanceDictationShortcut(this.shortcut, edge, now);
    this.shortcut = next.state;
    let action: Promise<unknown> | undefined;
    if (next.action === "start-hold") action = this.start("hold");
    else if (next.action === "start-locked") action = this.start("locked");
    else if (next.action === "stop") action = this.stop();
    else if (next.action === "cancel") action = this.cancel(false);
    if (action) void action.catch((error) => this.fail(error));
  }

  async stop(interrupted = false, capturedDurationMs?: number) {
    const session = this.session;
    if (!session || !this.current(session) || this.state.phase === "processing") return;
    clearTimeout(this.limitTimer);
    this.shortcut = emptyDictationShortcutState();
    session.interrupted = interrupted;
    this.publish({ phase: "processing", level: 0 });
    try {
      if (capturedDurationMs === undefined) {
        const capture = await this.queueNative(() => this.options.native.stop(session.id));
        session.durationMs = capture.durationMs;
      } else session.durationMs = capturedDurationMs;
      if (!this.current(session)) return;
      if (session.durationMs < 250) {
        await this.cancel();
        return;
      }
      const terms = dictationModelHints(session.dictionary);
      const transcription = await this.options.inference.transcribeWithLanguage({
        audioPath: session.audioPath,
        modelId: session.preferences.speechModel,
        language: session.preferences.language,
        terms,
        signal: session.abort.signal,
      });
      const originalText = cleanRecognizedText(transcription.text);
      if (!this.current(session)) return;
      if (!originalText) {
        this.publish({ phase: "error", error: "No speech detected. Try recording again." });
        return;
      }
      let text = applyDictationDictionary(originalText, session.dictionary);
      let cleanup: DictationHistoryEntry["cleanup"] = session.preferences.cleanupEnabled
        ? "unavailable"
        : "disabled";
      if (
        session.preferences.cleanupEnabled &&
        this.options.models.isInstalled("qwen-cleanup") &&
        text.length <= 6000
      ) {
        try {
          const candidate = applyDictationDictionary(
            await this.options.inference.cleanup({
              requireLoaded: true,
              text,
              terms,
              language:
                session.preferences.language === "auto"
                  ? (transcription.language ?? "auto")
                  : session.preferences.language,
              signal: session.abort.signal,
            }),
            session.dictionary,
          );
          if (acceptableDictationCleanup(text, candidate, terms)) {
            text = candidate.trim();
            cleanup = "applied";
          }
        } catch {
          /* Usable recognition survives a failed cleanup step. */
        }
      }
      if (!this.current(session)) return;
      let delivery: DictationHistoryEntry["delivery"] = session.mode === "test" ? "test" : "manual";
      let deliveryError: string | null = null;
      if (!interrupted && session.mode !== "test") {
        try {
          const insertion = await this.options.native.insert(text);
          delivery = insertion.status;
          if (delivery !== "inserted") deliveryError = insertion.reason ?? null;
        } catch {
          delivery = "unconfirmed";
        }
      }
      if (!this.current(session)) return;
      const entry: DictationHistoryEntry = {
        id: session.id,
        createdAt: new Date().toISOString(),
        originalText,
        text,
        durationMs: session.durationMs,
        modelId: session.preferences.speechModel,
        language: session.preferences.language,
        cleanup,
        delivery,
      };
      let error: string | null =
        deliveryError ??
        (cleanup === "unavailable" ? "Cleanup unavailable. Your transcript is ready." : null);
      if (interrupted)
        error = "Microphone disconnected. Review the captured speech before copying.";
      if (session.preferences.saveHistory && session.mode !== "test") {
        try {
          await this.options.storage.saveHistory(session.accountId, entry);
        } catch {
          error = "Your text is ready, but it could not be saved to history.";
        }
      }
      if (this.current(session))
        this.publish({ phase: "result", result: entry, durationMs: session.durationMs, error });
    } catch (error) {
      if (this.current(session))
        this.publish({
          phase: "error",
          error:
            error instanceof Error ? error.message : "Transcription failed. Try recording again.",
        });
    } finally {
      await NodeFSP.rm(session.audioPath, { force: true }).catch(() => {});
      if (this.session === session) {
        this.session = null;
        this.scheduleUnload();
      }
    }
  }

  async cancel(resetShortcut = true) {
    this.sessionGeneration++;
    clearTimeout(this.limitTimer);
    if (resetShortcut) this.shortcut = emptyDictationShortcutState();
    const session = this.session;
    this.session = null;
    session?.abort.abort();
    this.publish({
      phase: this.idlePhase(),
      mode: "hold",
      result: null,
      level: 0,
      durationMs: 0,
      error: null,
    });
    if (session) {
      await this.queueNative(() => this.options.native.cancel(session.id)).catch(() => {});
      await NodeFSP.rm(session.audioPath, { force: true }).catch(() => {});
    }
    this.scheduleUnload();
  }

  private scheduleUnload() {
    clearTimeout(this.idleTimer);
    const minutes = this.state.preferences.idleUnloadMinutes;
    if (this.isBusy || minutes < 0 || this.disposed) return;
    this.idleTimer = setTimeout(() => {
      void Promise.resolve(this.options.inference.unload()).then(
        () => this.publish(),
        (error) => this.fail(error),
      );
    }, minutes * 60_000);
    this.idleTimer.unref();
  }
  private async prune() {
    if (this.accountId)
      await this.options.storage.prune(
        this.accountId,
        this.state.preferences.retentionDays,
        Date.now(),
      );
  }
  async listHistory() {
    await this.initialize();
    const accountId = this.accountId;
    if (!accountId) return [];
    await this.options.storage.prune(accountId, this.state.preferences.retentionDays, Date.now());
    const entries = await this.options.storage.history(accountId);
    return accountId === this.accountId ? entries : [];
  }
  async dispose() {
    if (this.disposed) return;
    await this.cancel();
    this.disposed = true;
    clearTimeout(this.idleTimer);
    clearInterval(this.pruneTimer);
    await this.options.native.close();
    await this.options.inference.unload();
    await this.options.models.dispose();
    await this.options.storage.flush();
  }
}
