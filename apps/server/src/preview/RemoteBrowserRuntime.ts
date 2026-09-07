import { fillBrowserLoginFields } from "@spiritdevs/shared/browserPasswordAutofill";
// @effect-diagnostics nodeBuiltinImport:off - Playwright and streaming encoder run at this adapter boundary.
// @effect-diagnostics globalDate:off globalTimers:off - Native browser events and encoder frame pacing use the Node event loop.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Page,
  type Request,
} from "playwright";
import * as Schema from "effect/Schema";
import {
  PreviewTabId,
  PreviewAutomationOpenInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationClickInput,
  PreviewAutomationTypeInput,
  PreviewAutomationPressInput,
  PreviewAutomationScrollInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationWaitForInput,
  PreviewAutomationResizeInput,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationRecordingReadInput,
  type PreviewAutomationRequest,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
  type PreviewRemoteCommand,
  type PreviewRemoteFrame,
  type PreviewRemoteTab,
} from "@spiritdevs/contracts";
import { normalizePreviewUrl } from "@spiritdevs/shared/preview";
import { resolvePreviewViewport } from "@spiritdevs/shared/previewViewport";
import { createAttachmentId } from "../attachmentStore.ts";

const decodePreviewAutomationOpenInput = Schema.decodeUnknownSync(PreviewAutomationOpenInput);
const decodePreviewAutomationNavigateInput = Schema.decodeUnknownSync(
  PreviewAutomationNavigateInput,
);
const decodePreviewAutomationClickInput = Schema.decodeUnknownSync(PreviewAutomationClickInput);
const decodePreviewAutomationTypeInput = Schema.decodeUnknownSync(PreviewAutomationTypeInput);
const decodePreviewAutomationPressInput = Schema.decodeUnknownSync(PreviewAutomationPressInput);
const decodePreviewAutomationScrollInput = Schema.decodeUnknownSync(PreviewAutomationScrollInput);
const decodePreviewAutomationEvaluateInput = Schema.decodeUnknownSync(
  PreviewAutomationEvaluateInput,
);
const decodePreviewAutomationWaitForInput = Schema.decodeUnknownSync(PreviewAutomationWaitForInput);
const decodePreviewAutomationResizeInput = Schema.decodeUnknownSync(PreviewAutomationResizeInput);
const decodePreviewAutomationSetColorSchemeInput = Schema.decodeUnknownSync(
  PreviewAutomationSetColorSchemeInput,
);
const decodePreviewAutomationRecordingReadInputOption = Schema.decodeUnknownOption(
  PreviewAutomationRecordingReadInput,
);

interface Recording {
  process: NodeChildProcess.ChildProcessWithoutNullStreams;
  path: string;
  id: string;
  startedAt: string;
  timer: ReturnType<typeof setInterval>;
  limitTimer: ReturnType<typeof setTimeout>;
  completion: Promise<void>;
  error: Error | null;
  finalization: Promise<BrowserArtifact> | null;
}
interface Tab {
  owner: BrowserSession;
  id: PreviewTabId;
  page: Page;
  openerTabId: PreviewTabId | null;
  session: CDPSession | null;
  captureStarting: Promise<void> | null;
  listeners: Set<(frame: PreviewRemoteFrame) => void>;
  frame: PreviewRemoteFrame | null;
  jpeg: Buffer | null;
  sequence: number;
  publishedAt: number;
  publishTimer: ReturnType<typeof setTimeout> | null;
  completedRecording: BrowserArtifact | null;
  recordingFinalization: Promise<BrowserArtifact> | null;
  recording: Recording | null;
  navigationRequest: Request | null;
  tail: Promise<unknown>;
}
interface BrowserSession {
  threadId: string;
  context: BrowserContext;
  tabs: Map<string, Tab>;
  selectedTabId: PreviewTabId | null;
  closing: Promise<void> | null;
  metadata: PreviewRemoteTab[];
  metadataRevision: number;
  metadataTail: Promise<void>;
}
export interface BrowserArtifact {
  id: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export const REMOTE_BROWSER_CAPTURE_MAX_COUNT = 50;
export const REMOTE_BROWSER_CAPTURE_MAX_BYTES = 1024 * 1024 * 1024;

const BrowserCaptureIndex = Schema.Struct({
  version: Schema.Literal(1),
  threadId: Schema.String,
  captures: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      fileName: Schema.String,
      mimeType: Schema.Literals(["image/png", "video/mp4"]),
      sizeBytes: Schema.Number,
      createdAt: Schema.String,
    }),
  ),
});
const decodeCaptureIndex = Schema.decodeUnknownSync(Schema.fromJsonString(BrowserCaptureIndex));
const encodeCaptureIndex = Schema.encodeSync(Schema.fromJsonString(BrowserCaptureIndex));

/** Each task owns its browser profile and pages; client connections never own their lifetime. */
export class RemoteBrowserRuntime {
  private sessions = new Map<string, Promise<BrowserSession>>();
  private closed = false;
  private closedThreads = new Set<string>();
  private threadClosures = new Map<string, Promise<void>>();
  private artifactLoads = new Map<string, Promise<void>>();
  private artifactWrites = new Map<string, Promise<void>>();
  private artifacts = new Map<string, BrowserArtifact>();
  private artifactOwners = new Map<string, string>();
  private watchers = new Map<string, Set<(frame: PreviewRemoteFrame) => void>>();
  private readonly directory: string;
  private readonly attachmentsDirectory: string;
  private readonly launch: typeof chromium.launchPersistentContext;
  private readonly encoderExecutable: string;

  constructor(
    directory: string,
    attachmentsDirectory: string,
    launch: typeof chromium.launchPersistentContext = chromium.launchPersistentContext.bind(
      chromium,
    ),
    encoderExecutable = process.env.PATHWAY_BROWSER_FFMPEG?.trim() || "ffmpeg",
  ) {
    this.directory = directory;
    this.attachmentsDirectory = attachmentsDirectory;
    this.launch = launch;
    this.encoderExecutable = encoderExecutable;
  }

  private assertThreadOpen(threadId: string) {
    if (this.closedThreads.has(threadId)) throw new Error("This task browser has been closed.");
  }

  private async session(threadId: string): Promise<BrowserSession> {
    this.assertThreadOpen(threadId);
    if (this.closed) throw new Error("The environment browser has stopped.");
    const existing = this.sessions.get(threadId);
    if (existing) {
      const session = await existing;
      this.assertThreadOpen(threadId);
      if (!session.closing) return session;
      await session.closing;
      return this.session(threadId);
    }
    if (this.sessions.size >= 8)
      throw new Error(
        "Eight tasks already have an environment browser open. Close the browser tabs in another task before opening one here.",
      );
    const starting = this.startSession(threadId);
    this.sessions.set(threadId, starting);
    try {
      return await starting;
    } catch (error) {
      if (this.sessions.get(threadId) === starting) this.sessions.delete(threadId);
      throw error;
    }
  }

  private async startSession(threadId: string): Promise<BrowserSession> {
    const profile = NodePath.join(
      this.directory,
      "profiles",
      NodeCrypto.createHash("sha256").update(threadId).digest("hex"),
    );
    await NodeFSP.mkdir(profile, { recursive: true, mode: 0o700 });
    const context = await this.launch(profile, {
      headless: true,
      viewport: { width: 1280, height: 800 },
      acceptDownloads: true,
      timeout: 20_000,
    }).catch(() => {
      throw new Error(
        "Cannot start the environment browser. Install Chromium on this environment with npx playwright@1.60.0 install chromium (Linux may also need install-deps chromium).",
      );
    });
    if (this.closed || this.closedThreads.has(threadId)) {
      await context.close();
      throw new Error("The environment browser has stopped.");
    }
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(15_000);
    const session: BrowserSession = {
      threadId,
      context,
      tabs: new Map(),
      selectedTabId: null,
      closing: null,
      metadata: [],
      metadataRevision: 0,
      metadataTail: Promise.resolve(),
    };
    context.on("page", (page) => {
      void this.register(session, page).catch(() => undefined);
    });
    context.on("close", () => {
      for (const tab of session.tabs.values()) {
        if (tab.publishTimer) clearTimeout(tab.publishTimer);
        tab.publishTimer = null;
        if (tab.recording) void this.stopRecording(tab).catch(() => undefined);
      }
      session.tabs.clear();
      session.selectedTabId = null;
      void this.forgetSession(session);
      void this.publishMetadata(session).catch(() => undefined);
    });
    for (const page of context.pages()) await this.register(session, page);
    return session;
  }

  private async register(session: BrowserSession, page: Page): Promise<Tab> {
    const existing = [...session.tabs.values()].find((tab) => tab.page === page);
    if (existing) return existing;
    // Insert before awaiting opener/title so simultaneous page events cannot duplicate the tab.
    const tab: Tab = {
      owner: session,
      id: PreviewTabId.make(`remote-${NodeCrypto.randomUUID()}`),
      page,
      openerTabId: null,
      session: null,
      captureStarting: null,
      listeners: new Set(),
      frame: null,
      jpeg: null,
      sequence: 0,
      publishedAt: 0,
      publishTimer: null,
      completedRecording: null,
      recordingFinalization: null,
      recording: null,
      navigationRequest: null,
      tail: Promise.resolve(),
    };
    session.tabs.set(tab.id, tab);
    session.selectedTabId ??= tab.id;
    page.on("close", () => {
      session.tabs.delete(tab.id);
      if (tab.publishTimer) clearTimeout(tab.publishTimer);
      tab.publishTimer = null;
      if (session.selectedTabId === tab.id)
        session.selectedTabId = session.tabs.values().next().value?.id ?? null;
      if (tab.recording) void this.stopRecording(tab).catch(() => undefined);
      if (session.tabs.size === 0) void this.closeSession(session).catch(() => undefined);
      void this.publishMetadata(session).catch(() => undefined);
    });
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame())
        tab.navigationRequest = request;
    });
    const navigationFinished = (request: Request) => {
      if (tab.navigationRequest === request) tab.navigationRequest = null;
    };
    page.on("requestfailed", navigationFinished);
    page.on("requestfinished", navigationFinished);
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) tab.navigationRequest = null;
      void this.publishMetadata(session).catch(() => undefined);
    });
    page.on("domcontentloaded", () => {
      void this.publishMetadata(session).catch(() => undefined);
    });
    page.on("dialog", (dialog) => {
      void dialog.dismiss().catch(() => undefined);
    });
    page.on("download", (download) => {
      // Keep downloads on the environment; never silently write into the user's checkout.
      const file = NodePath.join(
        this.directory,
        "downloads",
        `${NodeCrypto.randomUUID()}-${download.suggestedFilename().replace(/[^a-zA-Z0-9._-]/g, "_")}`,
      );
      void NodeFSP.mkdir(NodePath.join(this.directory, "downloads"), { recursive: true })
        .then(() => download.saveAs(file))
        .catch(() => undefined);
    });
    const opener = await page.opener().catch(() => null);
    tab.openerTabId =
      [...session.tabs.values()].find((candidate) => candidate.page === opener)?.id ?? null;
    await this.publishMetadata(session);
    return tab;
  }

  private async forgetSession(session: BrowserSession) {
    const pending = this.sessions.get(session.threadId);
    if (pending && (await pending) === session && this.sessions.get(session.threadId) === pending)
      this.sessions.delete(session.threadId);
  }

  private closeSession(session: BrowserSession): Promise<void> {
    session.closing ??= Promise.resolve()
      .then(() => session.context.close())
      .finally(() => this.forgetSession(session));
    return session.closing;
  }

  private async tabs(session: BrowserSession): Promise<PreviewRemoteTab[]> {
    return Promise.all(
      [...session.tabs.values()]
        .filter((tab) => !tab.page.isClosed())
        .map(async (tab) => ({
          tabId: tab.id,
          url: tab.page.url(),
          title: await tab.page.title().catch(() => ""),
          openerTabId: tab.openerTabId,
          recording: tab.recording !== null,
        })),
    );
  }

  private publishMetadata(session: BrowserSession, artifactChanged = false) {
    const publishing = session.metadataTail.then(async () => {
      const tabs = await this.tabs(session);
      if (!artifactChanged && JSON.stringify(tabs) === JSON.stringify(session.metadata)) return;
      session.metadata = tabs;
      session.metadataRevision += 1;
      const metadata: PreviewRemoteFrame = {
        tabId: PreviewTabId.make("remote-metadata"),
        mimeType: "image/jpeg",
        data: "",
        width: 0,
        height: 0,
        sequence: 0,
        tabs,
        metadataRevision: session.metadataRevision,
      };
      for (const listener of this.watchers.get(session.threadId) ?? []) listener(metadata);
    });
    session.metadataTail = publishing.catch(() => undefined);
    return publishing;
  }

  private async getTab(
    threadId: string,
    tabId?: string,
  ): Promise<{ session: BrowserSession; tab: Tab }> {
    const pending = this.sessions.get(threadId);
    if (!pending) throw new Error("This browser tab is closed. Open or select an existing tab.");
    const session = await pending;
    const tab = session.tabs.get(tabId ?? session.selectedTabId ?? "");
    if (!tab || tab.page.isClosed())
      throw new Error("This browser tab is closed. Open or select an existing tab.");
    return { session, tab };
  }

  private serial<T>(tab: Tab, action: () => Promise<T>): Promise<T> {
    const result = tab.tail.then(() => {
      this.assertThreadOpen(tab.owner.threadId);
      if (tab.page.isClosed()) throw new Error("The browser tab closed before the action ran.");
      return action();
    });
    tab.tail = result.catch(() => undefined);
    return result;
  }

  async list(threadId: string) {
    const pending = this.sessions.get(threadId);
    if (!pending)
      return { tabs: [], selectedTabId: null, artifacts: await this.getArtifacts(threadId) };
    const session = await pending;
    return {
      tabs: await this.tabs(session),
      selectedTabId: session.selectedTabId,
      artifacts: await this.getArtifacts(threadId),
    };
  }

  private captureIndexPath(threadId: string) {
    return NodePath.join(
      this.directory,
      "captures",
      `${NodeCrypto.createHash("sha256").update(threadId).digest("hex")}.json`,
    );
  }

  private loadArtifacts(threadId: string): Promise<void> {
    const existing = this.artifactLoads.get(threadId);
    if (existing) return existing;
    const load = async () => {
      let content: string;
      try {
        content = await NodeFSP.readFile(this.captureIndexPath(threadId), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const index = decodeCaptureIndex(content);
      if (index.threadId !== threadId)
        throw new Error("Browser capture index ownership does not match this task.");
      const recovered: BrowserArtifact[] = [];
      for (const capture of index.captures) {
        const extension = capture.mimeType === "image/png" ? "png" : "mp4";
        if (
          capture.fileName !== `${capture.id}.${extension}` ||
          NodePath.basename(capture.fileName) !== capture.fileName
        )
          throw new Error("Browser capture index contains an invalid file name.");
        const path = NodePath.join(this.attachmentsDirectory, capture.fileName);
        const stat = await NodeFSP.lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        // Attachment retention can remove a file independently of this index.
        if (!stat?.isFile()) continue;
        const { fileName: _, ...metadata } = capture;
        recovered.push({ ...metadata, path, sizeBytes: stat.size });
      }
      const retained = await this.pruneCaptures(recovered);
      if (
        retained.length !== index.captures.length ||
        retained.some(
          (capture, position) => capture.sizeBytes !== index.captures[position]?.sizeBytes,
        )
      )
        await this.writeCaptureIndex(threadId, retained);
      this.replaceArtifacts(threadId, retained);
    };
    const pending = load();
    this.artifactLoads.set(threadId, pending);
    void pending.catch(() => {
      if (this.artifactLoads.get(threadId) === pending) this.artifactLoads.delete(threadId);
    });
    return pending;
  }

  async getArtifacts(threadId: string): Promise<BrowserArtifact[]> {
    await this.loadArtifacts(threadId);
    await this.artifactWrites.get(threadId);
    return [...this.artifacts.values()].filter(
      (artifact) => this.artifactOwners.get(artifact.path) === threadId,
    );
  }

  private async pruneCaptures(captures: BrowserArtifact[], removeAll = false) {
    let retainedBytes = captures.reduce((total, capture) => total + capture.sizeBytes, 0);
    let removeCount = 0;
    const maxCount = removeAll ? 0 : REMOTE_BROWSER_CAPTURE_MAX_COUNT;
    while (
      removeCount < captures.length &&
      (captures.length - removeCount > maxCount || retainedBytes > REMOTE_BROWSER_CAPTURE_MAX_BYTES)
    ) {
      const capture = captures[removeCount++]!;
      // These exact files came from the owned index; never sweep the shared attachment directory.
      await NodeFSP.unlink(capture.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      this.artifacts.delete(capture.path);
      this.artifactOwners.delete(capture.path);
      retainedBytes -= capture.sizeBytes;
    }
    return captures.slice(removeCount);
  }

  private replaceArtifacts(threadId: string, captures: BrowserArtifact[]) {
    for (const [path, owner] of this.artifactOwners)
      if (owner === threadId) {
        this.artifactOwners.delete(path);
        this.artifacts.delete(path);
      }
    for (const artifact of captures) {
      this.artifacts.set(artifact.path, artifact);
      this.artifactOwners.set(artifact.path, threadId);
    }
  }

  private async writeCaptureIndex(threadId: string, artifacts: BrowserArtifact[]) {
    const captures = artifacts.map(({ path, ...metadata }) => ({
      ...metadata,
      mimeType: metadata.mimeType as "image/png" | "video/mp4",
      fileName: NodePath.basename(path),
    }));
    const path = this.captureIndexPath(threadId);
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
    try {
      await NodeFSP.writeFile(temporary, encodeCaptureIndex({ version: 1, threadId, captures }), {
        mode: 0o600,
      });
      await NodeFSP.rename(temporary, path);
    } finally {
      await NodeFSP.rm(temporary, { force: true });
    }
  }

  private rememberArtifact(threadId: string, artifact: BrowserArtifact): Promise<void> {
    const save = async () => {
      if (this.closedThreads.has(threadId)) {
        await NodeFSP.unlink(artifact.path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        throw new Error("This task browser has been closed.");
      }
      await this.loadArtifacts(threadId);
      const owned = [...this.artifacts.values()].filter(
        (candidate) =>
          this.artifactOwners.get(candidate.path) === threadId && candidate.path !== artifact.path,
      );
      if (artifact.sizeBytes > REMOTE_BROWSER_CAPTURE_MAX_BYTES) {
        await NodeFSP.unlink(artifact.path);
        throw new Error("The browser capture exceeds this task's 1 GiB capture limit.");
      }
      const retained = await this.pruneCaptures([...owned, artifact]);
      await this.writeCaptureIndex(threadId, retained);
      this.replaceArtifacts(threadId, retained);
    };
    const pending = (this.artifactWrites.get(threadId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(save)
      .catch(async (error) => {
        // A failed index write must not leave a new capture outside the retention index.
        if (!this.artifacts.has(artifact.path)) await NodeFSP.rm(artifact.path, { force: true });
        throw error;
      });
    this.artifactWrites.set(threadId, pending);
    void pending
      .finally(() => {
        if (this.artifactWrites.get(threadId) === pending) this.artifactWrites.delete(threadId);
      })
      .catch(() => undefined);
    return pending;
  }

  async command(
    input: PreviewRemoteCommand,
    beforeAction?: () => Promise<void>,
  ): Promise<{
    tabs: PreviewRemoteTab[];
    selectedTabId: PreviewTabId | null;
    artifacts: BrowserArtifact[];
    artifact?: BrowserArtifact;
  }> {
    if (input.action === "selectHost")
      throw new Error("Browser host selection is handled by the environment service.");
    if (input.action === "list") return this.list(input.threadId);
    if (input.action === "open") {
      await beforeAction?.();
      const session = await this.session(input.threadId);
      const blank = [...session.tabs.values()].find(
        (tab) => tab.page.url() === "about:blank" && !tab.openerTabId,
      );
      const tab =
        blank && session.tabs.size === 1
          ? blank
          : await this.register(session, await session.context.newPage());
      session.selectedTabId = tab.id;
      await this.serial(tab, async () => {
        await beforeAction?.();
        if (input.url)
          await tab.page.goto(normalizePreviewUrl(input.url), { waitUntil: "domcontentloaded" });
      });
      await this.publishMetadata(session);
      return this.list(input.threadId);
    }
    const { session, tab } = await this.getTab(input.threadId, input.tabId);
    let artifact: BrowserArtifact | undefined;
    await this.serial(tab, async () => {
      await beforeAction?.();
      session.selectedTabId = tab.id;
      switch (input.action) {
        case "autofill": {
          if (new URL(tab.page.url()).origin !== input.origin)
            throw new Error(
              "The page origin changed. Select the correct login page before filling credentials.",
            );
          const result = await tab.page
            .evaluate(fillBrowserLoginFields, {
              origin: input.origin,
              username: input.username,
              password: input.password,
            })
            .catch(() => "ambiguous" as const);
          if (result !== "filled")
            throw new Error(
              result === "origin"
                ? "The page origin changed before credentials could be filled."
                : "A unique visible login form was not found. Choose the login form and try again.",
            );
          break;
        }
        case "navigate":
          await tab.page.goto(normalizePreviewUrl(input.url), { waitUntil: "domcontentloaded" });
          break;
        case "close":
          if (tab.recording) artifact = await this.stopRecording(tab);
          await tab.page.close();
          if (session.tabs.size === 0) await this.closeSession(session);
          break;
        case "back":
          await tab.page.goBack({ waitUntil: "domcontentloaded" });
          break;
        case "forward":
          await tab.page.goForward({ waitUntil: "domcontentloaded" });
          break;
        case "reload":
          await tab.page.reload({ waitUntil: "domcontentloaded" });
          break;
        case "click":
          await tab.page.mouse.click(input.x, input.y);
          break;
        case "type":
          await tab.page.keyboard.insertText(input.text);
          break;
        case "press":
          await tab.page.keyboard.press(input.key);
          break;
        case "scroll":
          await tab.page.mouse.wheel(input.deltaX, input.deltaY);
          break;
        case "resize":
          await tab.page.setViewportSize({ width: input.width, height: input.height });
          break;
        case "screenshot":
          artifact = await this.screenshotArtifact(input.threadId, tab);
          break;
        case "recordingStart":
          await this.startRecording(input.threadId, tab);
          break;
        case "recordingStop":
          artifact = await this.stopRecording(tab);
          break;
      }
    });
    await this.publishMetadata(session, artifact !== undefined);
    return {
      ...(await this.list(input.threadId)),
      selectedTabId: session.tabs.has(tab.id) ? tab.id : session.selectedTabId,
      ...(artifact ? { artifact } : {}),
    };
  }

  private async isLoading(tab: Tab): Promise<boolean> {
    if (tab.navigationRequest) return true;
    const page = tab.page;
    // Commit and DOMContentLoaded are earlier than full readiness. A replaced execution
    // context also means we cannot yet claim the current document has finished loading.
    return page.evaluate("document.readyState !== 'complete'").then(
      (loading) => tab.navigationRequest !== null || loading !== false,
      () => true,
    );
  }

  private async status(tab: Tab): Promise<PreviewAutomationStatus> {
    return {
      available: true,
      visible: tab.listeners.size > 0,
      tabId: tab.id,
      url: tab.page.url(),
      title: await tab.page.title(),
      loading: await this.isLoading(tab),
      viewport: tab.page.viewportSize() ?? { width: 1280, height: 800 },
      viewportSetting: { _tag: "fill" },
    };
  }

  async automate(request: PreviewAutomationRequest): Promise<unknown> {
    const deadline = Date.now() + request.timeoutMs;
    // Saved captures belong to the task and remain readable after their page closes.
    if (request.operation === "recordingStop") {
      const reading = decodePreviewAutomationRecordingReadInputOption(request.input);
      if (reading._tag === "Some") {
        await this.loadArtifacts(request.threadId);
        await this.artifactWrites.get(request.threadId);
        const artifact = this.artifacts.get(reading.value.path);
        if (!artifact || this.artifactOwners.get(artifact.path) !== request.threadId)
          throw new Error("Unknown browser recording artifact.");
        const file = await NodeFSP.open(artifact.path, "r");
        try {
          const data = Buffer.alloc(
            Math.min(reading.value.length, Math.max(0, artifact.sizeBytes - reading.value.offset)),
          );
          const { bytesRead } = await file.read(data, 0, data.length, reading.value.offset);
          return {
            data: data.subarray(0, bytesRead).toString("base64"),
            offset: reading.value.offset,
            nextOffset: reading.value.offset + bytesRead,
            totalBytes: artifact.sizeBytes,
          };
        } finally {
          await file.close();
        }
      }
    }
    if (request.operation === "open") {
      const input = decodePreviewAutomationOpenInput(request.input);
      const session = await this.session(request.threadId);
      const checkDeadline = () => {
        if (Date.now() >= deadline)
          throw new Error("The browser request expired before it could run.");
      };
      checkDeadline();
      const existing =
        input.reuseExistingTab !== false &&
        session.tabs.get(request.tabId ?? session.selectedTabId ?? "");
      if (request.tabIdExplicit && !existing)
        throw new Error("The requested browser tab no longer exists.");
      const tab = existing || (await this.register(session, await session.context.newPage()));
      return this.serial(tab, async () => {
        checkDeadline();
        session.selectedTabId = tab.id;
        if (input.url)
          await tab.page.goto(normalizePreviewUrl(input.url), {
            waitUntil: "domcontentloaded",
            timeout: Math.max(1, Math.min(15_000, deadline - Date.now())),
          });
        return this.status(tab);
      });
    }
    const { session, tab } = await this.getTab(request.threadId, request.tabId);
    return this.serial(tab, async () => {
      if (Date.now() >= deadline)
        throw new Error("The browser request expired before it could run.");
      const page = tab.page;
      const remainingTimeout = (limit = 15_000) => {
        const timeout = Math.min(limit, deadline - Date.now());
        if (timeout <= 0) throw new Error("The browser request expired before it could run.");
        return timeout;
      };
      switch (request.operation) {
        case "status":
          return this.status(tab);
        case "navigate": {
          const input = decodePreviewAutomationNavigateInput(request.input);
          const target = input.target;
          const url =
            input.url ??
            (target?.kind === "url"
              ? target.url
              : target?.kind === "environment-port"
                ? `${target.protocol ?? "http"}://localhost:${target.port}/${(target.path ?? "").replace(/^\//, "")}`
                : "");
          await page.goto(normalizePreviewUrl(url), {
            waitUntil:
              input.readiness === "load" || !input.readiness
                ? "load"
                : input.readiness === "none"
                  ? "commit"
                  : "domcontentloaded",
            timeout: remainingTimeout(input.timeoutMs),
          });
          await this.publishMetadata(session);
          return this.status(tab);
        }
        case "click": {
          const input = decodePreviewAutomationClickInput(request.input);
          const locator = input.locator ?? input.selector;
          if (locator) await page.locator(locator).click({ timeout: remainingTimeout() });
          else await page.mouse.click(input.x!, input.y!);
          return {};
        }
        case "type": {
          const input = decodePreviewAutomationTypeInput(request.input);
          const locator = input.locator ?? input.selector;
          if (locator) {
            if (input.clear)
              await page.locator(locator).fill(input.text, { timeout: remainingTimeout() });
            else
              await page
                .locator(locator)
                .pressSequentially(input.text, { timeout: remainingTimeout() });
          } else {
            if (input.clear) {
              await page.keyboard.press("ControlOrMeta+A");
              await page.keyboard.press("Backspace");
            }
            await page.keyboard.insertText(input.text);
          }
          return {};
        }
        case "press": {
          const input = decodePreviewAutomationPressInput(request.input);
          await page.keyboard.press([...(input.modifiers ?? []), input.key].join("+"));
          return {};
        }
        case "scroll": {
          const input = decodePreviewAutomationScrollInput(request.input);
          const locator = input.locator ?? input.selector;
          if (locator)
            await page.locator(locator).evaluate(
              (element, delta) => element.scrollBy(delta.x, delta.y),
              {
                x: input.deltaX ?? 0,
                y: input.deltaY ?? 0,
              },
              { timeout: remainingTimeout() },
            );
          else await page.mouse.wheel(input.deltaX ?? 0, input.deltaY ?? 0);
          return {};
        }
        case "evaluate": {
          const input = decodePreviewAutomationEvaluateInput(request.input);
          return this.evaluate(
            tab,
            input.expression,
            Math.max(1, Math.min(15_000, deadline - Date.now() - 100)),
          );
        }
        case "waitFor": {
          const input = decodePreviewAutomationWaitForInput(request.input);
          const waitDeadline = Math.min(deadline, Date.now() + (input.timeoutMs ?? 15_000));
          const timeout = () => remainingTimeout(waitDeadline - Date.now());
          const locator = input.locator ?? input.selector;
          if (locator)
            await page.locator(locator).waitFor({ state: "attached", timeout: timeout() });
          if (input.text)
            await page
              .getByText(input.text, { exact: false })
              .first()
              .waitFor({ timeout: timeout() });
          if (input.urlIncludes)
            await page.waitForURL((url) => url.href.includes(input.urlIncludes!), {
              timeout: timeout(),
            });
          return {};
        }
        case "resize": {
          const input = decodePreviewAutomationResizeInput(request.input);
          const setting = resolvePreviewViewport(input);
          const size =
            setting._tag === "fill"
              ? { width: 1280, height: 800 }
              : { width: setting.width, height: setting.height };
          await page.setViewportSize(size);
          return { tabId: tab.id, viewport: size, setting };
        }
        case "setColorScheme": {
          const input = decodePreviewAutomationSetColorSchemeInput(request.input);
          await page.emulateMedia({
            colorScheme: input.colorScheme === "system" ? null : input.colorScheme,
          });
          return { tabId: tab.id, colorScheme: input.colorScheme };
        }
        case "snapshot":
          return this.snapshot(tab);
        case "recordingStart":
          await this.startRecording(request.threadId, tab);
          await this.publishMetadata(session);
          return { tabId: tab.id, recording: true, startedAt: tab.recording!.startedAt };
        case "recordingStop": {
          return { ...(await this.stopRecording(tab)), tabId: tab.id };
        }
      }
    });
  }

  private async evaluate(tab: Tab, expression: string, timeoutMs: number): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const evaluation = tab.page.evaluate(expression);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Closing the execution context also cancels callbacks scheduled by async evaluation.
        // Do not leave a timed-out script running behind the next queued browser action.
        void tab.page.close({ runBeforeUnload: false }).catch(() => undefined);
        reject(
          new Error(
            "Browser script timed out. Its tab was closed to stop further execution; open a new tab to continue.",
          ),
        );
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([evaluation, timeout]);
      const serialized = JSON.stringify(result);
      if (serialized && Buffer.byteLength(serialized, "utf8") > 64_000)
        throw new Error("Browser script output exceeds 64 KB. Return a smaller result.");
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async snapshot(tab: Tab): Promise<PreviewAutomationSnapshot> {
    const page = tab.page;
    const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
    const [png, text, tree, title] = await Promise.all([
      page.screenshot({ type: "png", timeout: 5000, scale: "css" }),
      page
        .locator("body")
        .innerText({ timeout: 5000 })
        .catch(() => ""),
      page
        .locator("body")
        .ariaSnapshot({ timeout: 5000 })
        .catch(() => ""),
      page.title(),
    ]);
    return {
      url: page.url(),
      title,
      loading: await this.isLoading(tab),
      visibleText: text.slice(0, 32_000),
      interactiveElements: [],
      accessibilityTree: tree.slice(0, 48_000),
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      viewport: { ...viewport, deviceScaleFactor: 1 },
      screenshot: {
        mimeType: "image/png",
        data: png.toString("base64"),
        ...viewport,
        coordinateScale: { x: 1, y: 1 },
      },
    };
  }

  private async screenshotArtifact(threadId: string, tab: Tab): Promise<BrowserArtifact> {
    const id = createAttachmentId(threadId, "png");
    if (!id) throw new Error("Invalid task identifier.");
    await NodeFSP.mkdir(this.attachmentsDirectory, { recursive: true });
    const path = NodePath.join(this.attachmentsDirectory, `${id}.png`);
    await tab.page
      .screenshot({ path, type: "png", timeout: 5000, scale: "css" })
      .catch(async (error) => {
        await NodeFSP.rm(path, { force: true });
        throw error;
      });
    const artifact = {
      id,
      path,
      mimeType: "image/png",
      sizeBytes: (await NodeFSP.stat(path)).size,
      createdAt: new Date().toISOString(),
    };
    await this.rememberArtifact(threadId, artifact);
    return artifact;
  }

  private async startCapture(tab: Tab): Promise<void> {
    if (tab.captureStarting) return tab.captureStarting;
    if (tab.session) return;
    const start = async () => {
      const cdp = await tab.page.context().newCDPSession(tab.page);
      tab.session = cdp;
      cdp.on("Page.screencastFrame", (event) => {
        void cdp
          .send("Page.screencastFrameAck", { sessionId: event.sessionId })
          .catch(() => undefined);
        tab.jpeg = Buffer.from(event.data, "base64");
        const size = tab.page.viewportSize() ?? { width: 1280, height: 800 };
        const frame: PreviewRemoteFrame = {
          tabId: tab.id,
          mimeType: "image/jpeg",
          data: event.data,
          ...size,
          sequence: ++tab.sequence,
          tabs: tab.owner.metadata,
          metadataRevision: tab.owner.metadataRevision,
        };
        tab.frame = frame;
        const publish = () => {
          tab.publishTimer = null;
          if (!tab.frame || tab.page.isClosed() || tab.session !== cdp) return;
          tab.publishedAt = Date.now();
          for (const listener of tab.listeners)
            listener({
              ...tab.frame,
              tabs: tab.owner.metadata,
              metadataRevision: tab.owner.metadataRevision,
            });
        };
        const remaining = 160 - (Date.now() - tab.publishedAt);
        if (remaining <= 0) {
          if (tab.publishTimer) clearTimeout(tab.publishTimer);
          publish();
        } else if (!tab.publishTimer) {
          tab.publishTimer = setTimeout(publish, remaining);
        }
      });
      try {
        await cdp.send("Page.startScreencast", {
          format: "jpeg",
          quality: 75,
          maxWidth: 1280,
          maxHeight: 900,
          everyNthFrame: 1,
        });
      } catch (error) {
        tab.session = null;
        await cdp.detach().catch(() => undefined);
        throw error;
      }
    };
    tab.captureStarting = start();
    try {
      await tab.captureStarting;
    } finally {
      tab.captureStarting = null;
    }
  }

  private async stopUnusedCapture(tab: Tab) {
    if (tab.captureStarting) await tab.captureStarting.catch(() => undefined);
    if (tab.listeners.size || tab.recording || !tab.session) return;
    const cdp = tab.session;
    tab.session = null;
    if (tab.publishTimer) clearTimeout(tab.publishTimer);
    tab.publishTimer = null;
    await cdp.send("Page.stopScreencast").catch(() => undefined);
    await cdp.detach().catch(() => undefined);
    tab.jpeg = null;
  }

  async subscribe(
    threadId: string,
    tabId: string | undefined,
    listener: (frame: PreviewRemoteFrame) => void,
  ): Promise<() => Promise<void>> {
    if (tabId === undefined) {
      const unwatch = this.watchMetadata(threadId, listener);
      try {
        const state = await this.list(threadId);
        listener({
          tabId: PreviewTabId.make("remote-metadata"),
          mimeType: "image/jpeg",
          data: "",
          width: 0,
          height: 0,
          sequence: 0,
          tabs: state.tabs,
        });
      } catch (error) {
        unwatch();
        throw error;
      }
      return async () => unwatch();
    }
    const { session, tab } = await this.getTab(threadId, tabId);
    // The subscription outlives its selected page so a self-close or context loss
    // still tells the client to select another tab or show the empty browser.
    const unwatch = this.watchMetadata(threadId, listener);
    tab.listeners.add(listener);
    try {
      await this.startCapture(tab);
      await this.publishMetadata(session);
      listener({
        ...(tab.frame ?? {
          tabId: tab.id,
          mimeType: "image/jpeg",
          data: "",
          width: 0,
          height: 0,
          sequence: 0,
        }),
        tabs: session.metadata,
        metadataRevision: session.metadataRevision,
      });
    } catch (error) {
      unwatch();
      tab.listeners.delete(listener);
      await this.stopUnusedCapture(tab);
      throw error;
    }
    return async () => {
      unwatch();
      tab.listeners.delete(listener);
      await this.stopUnusedCapture(tab);
    };
  }

  private watchMetadata(threadId: string, listener: (frame: PreviewRemoteFrame) => void) {
    const listeners = this.watchers.get(threadId) ?? new Set();
    listeners.add(listener);
    this.watchers.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && this.watchers.get(threadId) === listeners)
        this.watchers.delete(threadId);
    };
  }

  private async startRecording(threadId: string, tab: Tab) {
    if (tab.recording) return;
    if (tab.recordingFinalization) await tab.recordingFinalization.catch(() => undefined);
    tab.recordingFinalization = null;
    const id = createAttachmentId(threadId, "mp4");
    if (!id) throw new Error("Invalid task identifier.");
    tab.jpeg = await tab.page.screenshot({ type: "jpeg", quality: 70, timeout: 5_000 });
    this.assertThreadOpen(threadId);
    await NodeFSP.mkdir(this.attachmentsDirectory, { recursive: true });
    const path = NodePath.join(this.attachmentsDirectory, `${id}.mp4`);
    const encoder = NodeChildProcess.spawn(
      this.encoderExecutable,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-probesize",
        "32",
        "-analyzeduration",
        "0",
        "-f",
        "image2pipe",
        "-framerate",
        "30",
        "-vcodec",
        "mjpeg",
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-vf",
        "pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-movflags",
        "+faststart",
        "-t",
        "600",
        "-fs",
        "524288000",
        path,
      ],
      { stdio: "pipe" },
    );
    const completion = new Promise<void>((resolve, reject) => {
      encoder.once("error", () =>
        reject(
          new Error(
            "Browser video requires full FFmpeg with libx264 on this environment. Install ffmpeg or set PATHWAY_BROWSER_FFMPEG to its executable, then retry.",
          ),
        ),
      );
      encoder.once("close", (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error("The video encoder failed; check free disk space and ffmpeg support."),
            ),
      );
    });
    // Observe rejection before awaiting spawn; a missing executable emits error without spawn.
    void completion.catch(() => undefined);
    encoder.stderr.resume();
    encoder.stdout.resume();
    await new Promise<void>((resolve, reject) => {
      encoder.once("spawn", resolve);
      encoder.once("error", () =>
        reject(
          new Error(
            "Browser video requires full FFmpeg with libx264 on this environment. Install ffmpeg or set PATHWAY_BROWSER_FFMPEG to its executable, then retry.",
          ),
        ),
      );
    });
    if (this.closedThreads.has(threadId) || this.closed) {
      encoder.kill();
      throw new Error("This task browser has been closed.");
    }
    const recording: Recording = {
      process: encoder,
      path,
      id,
      startedAt: new Date().toISOString(),
      completion,
      error: null,
      finalization: null,
      timer: setInterval(() => {
        if (tab.jpeg && !encoder.stdin.destroyed && !encoder.stdin.writableNeedDrain)
          encoder.stdin.write(tab.jpeg);
      }, 1000 / 30),
      limitTimer: setTimeout(() => {
        void this.stopRecording(tab).catch(() => undefined);
      }, 600_000),
    };
    // EPIPE is normal when the encoder reaches its configured duration/size limit.
    // Its exit status, observed below, determines whether the resulting video is usable.
    encoder.stdin.on("error", () => undefined);
    tab.recording = recording;
    tab.completedRecording = null;
    void completion
      .then(
        () => this.finalizeRecording(tab, recording),
        (error: Error) => {
          recording.error = error;
          return this.finalizeRecording(tab, recording);
        },
      )
      .catch(() => undefined);
    try {
      await this.startCapture(tab);
    } catch (error) {
      clearInterval(recording.timer);
      clearTimeout(recording.limitTimer);
      encoder.stdin.end();
      encoder.kill();
      tab.recording = null;
      throw error;
    }
  }

  private finalizeRecording(tab: Tab, recording: Recording): Promise<BrowserArtifact> {
    if (recording.finalization) return recording.finalization;
    clearInterval(recording.timer);
    clearTimeout(recording.limitTimer);
    if (tab.recording === recording) tab.recording = null;
    const finalize = async () => {
      try {
        await recording.completion;
        if (recording.error) throw recording.error;
        const artifact = {
          id: recording.id,
          path: recording.path,
          mimeType: "video/mp4",
          sizeBytes: (await NodeFSP.stat(recording.path)).size,
          createdAt: new Date().toISOString(),
        };
        if (artifact.sizeBytes === 0) throw new Error("The recording contains no video frames.");
        tab.completedRecording = artifact;
        await this.rememberArtifact(tab.owner.threadId, artifact);
        return artifact;
      } catch (error) {
        await NodeFSP.rm(recording.path, { force: true });
        throw error;
      } finally {
        await this.stopUnusedCapture(tab);
        await this.publishMetadata(tab.owner, true);
      }
    };
    recording.finalization = finalize();
    tab.recordingFinalization = recording.finalization;
    return recording.finalization;
  }

  private async stopRecording(tab: Tab): Promise<BrowserArtifact> {
    const recording = tab.recording;
    if (!recording) {
      const artifact = tab.recordingFinalization
        ? await tab.recordingFinalization
        : tab.completedRecording;
      if (artifact && this.artifacts.has(artifact.path)) return artifact;
      throw new Error("This tab has no active or retained recording.");
    }
    clearInterval(recording.timer);
    clearTimeout(recording.limitTimer);
    recording.process.stdin.end();
    const forceStop = setTimeout(() => recording.process.kill(), 10_000);
    try {
      return await this.finalizeRecording(tab, recording);
    } finally {
      clearTimeout(forceStop);
    }
  }

  /** Task deletion removes its indexed captures; browser profile and unrelated attachments remain. */
  closeThread(threadId: string): Promise<void> {
    const existing = this.threadClosures.get(threadId);
    if (existing) return existing;
    this.closedThreads.add(threadId);
    const pending = this.sessions.get(threadId);
    this.sessions.delete(threadId);
    const close = async () => {
      try {
        const session = await pending?.catch(() => undefined);
        if (session) {
          try {
            await Promise.allSettled(
              [...session.tabs.values()].map(async (tab) => {
                if (tab.recording || tab.recordingFinalization) await this.stopRecording(tab);
              }),
            );
          } finally {
            await this.closeSession(session);
            await this.publishMetadata(session, true);
          }
        }
        await this.artifactWrites.get(threadId)?.catch(() => undefined);
        await this.loadArtifacts(threadId);
        await this.pruneCaptures(
          [...this.artifacts.values()].filter(
            (artifact) => this.artifactOwners.get(artifact.path) === threadId,
          ),
          true,
        );
        await NodeFSP.rm(this.captureIndexPath(threadId), { force: true });
        this.replaceArtifacts(threadId, []);
      } finally {
        this.watchers.delete(threadId);
      }
    };
    const completion = close();
    this.threadClosures.set(threadId, completion);
    return completion;
  }

  async close() {
    this.closed = true;
    await Promise.allSettled(
      [...this.sessions.values()].map(async (pending) => {
        const session = await pending;
        for (const tab of session.tabs.values())
          if (tab.recording) await this.stopRecording(tab).catch(() => undefined);
        await session.context.close();
      }),
    );
    this.sessions.clear();
    this.watchers.clear();
  }
}
