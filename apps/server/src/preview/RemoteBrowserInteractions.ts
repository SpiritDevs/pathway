// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Playwright adapter and attachment filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import type { CDPSession, Dialog, Download, FileChooser, Frame, Page } from "playwright";
import { Schema } from "effect";
import {
  PreviewRemoteCursor,
  PreviewRemoteSelect,
  type PreviewRemoteInteractionCommand,
  type PreviewRemoteInteractionState,
  type PreviewTabId,
} from "@spiritdevs/contracts";
import {
  createAttachmentId,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import type { BrowserArtifact } from "./RemoteBrowserRuntime.ts";
import { remoteBrowserBridge, selectResponseScript } from "./remoteBrowserBridge.ts";

const BridgeMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready") }),
  Schema.Struct({ type: Schema.Literal("cursor"), cursor: PreviewRemoteCursor }),
  Schema.Struct({
    type: Schema.Literal("clipboard"),
    text: Schema.String.check(Schema.isMaxLength(64_000)),
  }),
  Schema.Struct({ type: Schema.Literal("select"), ...PreviewRemoteSelect.fields }),
]);
const decodeBridge = Schema.decodeUnknownOption(BridgeMessage);
export const BROWSER_TRANSFER_MAX_BYTES = 50 * 1024 * 1024;

export class RemoteBrowserInteractions {
  state: PreviewRemoteInteractionState;
  private watched = false;
  private closed = false;
  private closing: Promise<void> | null = null;
  private dialog: Dialog | null = null;
  private chooser: FileChooser | null = null;
  private selectFrame: Frame | null = null;
  private cdp: Promise<CDPSession> | null = null;
  private downloads = new Map<Download, Promise<void>>();
  private readonly page: Page;
  private readonly threadId: string;
  private readonly attachmentsDir: string;
  private readonly changed: () => void;
  private readonly remember: (artifact: BrowserArtifact) => Promise<void>;
  constructor(
    page: Page,
    threadId: string,
    tabId: PreviewTabId,
    attachmentsDir: string,
    changed: () => void,
    remember: (artifact: BrowserArtifact) => Promise<void>,
  ) {
    this.page = page;
    this.threadId = threadId;
    this.attachmentsDir = attachmentsDir;
    this.changed = changed;
    this.remember = remember;
    this.state = {
      tabId,
      cursor: "default",
      clipboard: null,
      dialog: null,
      fileChooser: null,
      select: null,
      downloads: [],
    };
    page.on("dialog", (dialog) => {
      if (!this.watched || this.closed) {
        void dialog.dismiss().catch(() => undefined);
        return;
      }
      this.dialog = dialog;
      this.update({
        dialog: {
          dialogId: NodeCrypto.randomUUID(),
          kind: dialog.type() as "alert" | "confirm" | "prompt" | "beforeunload",
          message: dialog.message().slice(0, 64_000),
          defaultValue: dialog.defaultValue().slice(0, 64_000),
        },
      });
    });
    page.on("filechooser", (chooser) => {
      if (!this.watched || this.closed) {
        void chooser.setFiles([]).catch(() => undefined);
        return;
      }
      this.chooser = chooser;
      this.update({
        fileChooser: { chooserId: NodeCrypto.randomUUID(), multiple: chooser.isMultiple() },
      });
    });
    page.on("download", (download) => {
      const work = this.saveDownload(download);
      this.downloads.set(download, work);
      void work.finally(() => this.downloads.delete(download)).catch(() => undefined);
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        this.chooser = null;
        this.selectFrame = null;
        this.update({ fileChooser: null, select: null, clipboard: null, cursor: "default" });
      } else if (frame === this.selectFrame) {
        this.selectFrame = null;
        this.update({ select: null });
      }
    });
  }
  private update(patch: Partial<PreviewRemoteInteractionState>) {
    if (this.closed) return;
    this.state = { ...this.state, ...patch };
    this.changed();
  }
  async install() {
    await this.page.exposeBinding("__pathwayBrowserEvent", ({ frame }, value: unknown) =>
      this.onBridge(frame, value),
    );
    await this.page.addInitScript(remoteBrowserBridge);
    await Promise.all(
      this.page.frames().map((frame) => frame.evaluate(remoteBrowserBridge).catch(() => undefined)),
    );
  }
  onBridge(frame: Frame, value: unknown) {
    const message = decodeBridge(value);
    if (message._tag === "None") return false;
    if (message.value.type === "ready") return this.watched;
    if (!this.watched || this.closed) return false;
    switch (message.value.type) {
      case "cursor":
        if (this.state.cursor !== message.value.cursor)
          this.update({ cursor: message.value.cursor });
        break;
      case "clipboard":
        this.update({ clipboard: message.value.text });
        break;
      case "select": {
        const { type: _, ...select } = message.value;
        this.selectFrame = frame;
        this.update({ select });
        break;
      }
    }
    return true;
  }
  async watch(watched: boolean) {
    this.watched = watched;
    // A dialog blocks page evaluation. Publish/replay it without waiting for page JS.
    void Promise.all(
      this.page
        .frames()
        .map((frame) =>
          frame.evaluate(`globalThis.__pathwayBrowserWatching = ${watched}`).catch(() => undefined),
        ),
    );
    if (!watched) {
      const dialog = this.dialog;
      this.dialog = null;
      const chooser = this.chooser;
      this.chooser = null;
      this.selectFrame = null;
      this.update({ dialog: null, fileChooser: null, select: null, clipboard: null });
      await dialog?.dismiss().catch(() => undefined);
      await chooser?.setFiles([]).catch(() => undefined);
    }
  }
  private async session() {
    this.cdp ??= this.page
      .context()
      .newCDPSession(this.page)
      .catch((error) => {
        this.cdp = null;
        throw error;
      });
    return this.cdp;
  }
  async command(input: PreviewRemoteInteractionCommand, authorize: () => Promise<void>) {
    if (this.closed) throw new Error("The browser tab is closed.");
    await authorize();
    switch (input.action) {
      case "dialogRespond": {
        if (!this.dialog || this.state.dialog?.dialogId !== input.dialogId)
          throw new Error("The dialog is no longer open.");
        const dialog = this.dialog;
        this.dialog = null;
        this.update({ dialog: null });
        if (input.accept) await dialog.accept(input.promptText);
        else await dialog.dismiss();
        break;
      }
      case "fileChooserRespond": {
        const chooser = this.chooser;
        if (!chooser || this.state.fileChooser?.chooserId !== input.chooserId)
          throw new Error("The file chooser is no longer open.");
        if (!chooser.isMultiple() && input.files.length > 1) throw new Error("Choose one file.");
        let total = 0;
        const files = [];
        for (const file of input.files) {
          const owner = parseThreadSegmentFromAttachmentId(file.attachmentId);
          if (owner !== "pending" && owner !== toSafeThreadAttachmentSegment(this.threadId))
            throw new Error("The attachment belongs to another task.");
          const path = resolveAttachmentPathById({
            attachmentsDir: this.attachmentsDir,
            attachmentId: file.attachmentId,
          });
          if (!path) throw new Error("The uploaded file is unavailable.");
          const stat = await NodeFSP.lstat(path);
          total += stat.size;
          if (!stat.isFile() || total > BROWSER_TRANSFER_MAX_BYTES)
            throw new Error("File selection exceeds 50 MiB or is not a regular file.");
          files.push({
            name: NodePath.basename(file.name.replaceAll("\\", "/")),
            mimeType: file.mimeType,
            buffer: await NodeFSP.readFile(path),
          });
        }
        await authorize();
        if (this.chooser !== chooser || this.state.fileChooser?.chooserId !== input.chooserId)
          throw new Error("The file chooser changed while uploading.");
        this.chooser = null;
        this.update({ fileChooser: null });
        await chooser.setFiles(files);
        break;
      }
      case "selectChoose": {
        if (!this.selectFrame || this.state.select?.selectId !== input.selectId)
          throw new Error("The select popup is no longer open.");
        const frame = this.selectFrame;
        await frame.evaluate(selectResponseScript(input.selectId, input.indices));
        if (this.selectFrame === frame && this.state.select?.selectId === input.selectId) {
          this.selectFrame = null;
          this.update({ select: null });
        }
        break;
      }
      case "clipboardRead":
      case "clipboardWrite": {
        const origin = new URL(this.page.url()).origin;
        if (!/^https?:/.test(origin))
          throw new Error("Clipboard access requires an HTTP or HTTPS page.");
        await this.page
          .context()
          .grantPermissions(["clipboard-read", "clipboard-write"], { origin });
        await authorize();
        if (new URL(this.page.url()).origin !== origin)
          throw new Error("The page changed before clipboard access.");
        if (input.action === "clipboardWrite") {
          await this.page.evaluate(`navigator.clipboard.writeText(${JSON.stringify(input.text)})`);
          this.update({ clipboard: input.text });
        } else {
          const text = await this.page.evaluate<string>("navigator.clipboard.readText()");
          this.update({ clipboard: text.slice(0, 64_000) });
        }
        break;
      }
      case "composition": {
        if (input.selectionStart > input.selectionEnd || input.selectionEnd > input.text.length)
          throw new Error("Invalid composition selection.");
        const cdp = await this.session();
        await authorize();
        if (input.phase === "commit") await cdp.send("Input.insertText", { text: input.text });
        else
          await cdp.send("Input.imeSetComposition", {
            text: input.phase === "cancel" ? "" : input.text,
            selectionStart: input.phase === "cancel" ? 0 : input.selectionStart,
            selectionEnd: input.phase === "cancel" ? 0 : input.selectionEnd,
          });
        break;
      }
      case "pointerMove":
        await this.page.mouse.move(input.x, input.y);
        break;
      case "wheel": {
        const cdp = await this.session();
        await authorize();
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: input.x,
          y: input.y,
          deltaX: input.deltaX,
          deltaY: input.deltaY,
          modifiers: input.modifiers ?? 0,
        });
        break;
      }
    }
    return this.state;
  }
  private async saveDownload(download: Download) {
    const downloadId = NodeCrypto.randomUUID();
    const name =
      NodePath.basename(download.suggestedFilename().replaceAll("\\", "/")).slice(0, 255) ||
      "download";
    const update = (patch: Partial<PreviewRemoteInteractionState["downloads"][number]>) =>
      this.update({
        downloads: this.state.downloads.map((d) =>
          d.downloadId === downloadId ? { ...d, ...patch } : d,
        ),
      });
    this.update({
      downloads: [...this.state.downloads.slice(-19), { downloadId, name, status: "downloading" }],
    });
    const id = createAttachmentId(this.threadId, "bin");
    if (!id) {
      update({ status: "failed", error: "Invalid task identifier." });
      return;
    }
    const path = NodePath.join(this.attachmentsDir, `${id}.bin`);
    const partial = `${path}.part`;
    try {
      await NodeFSP.mkdir(this.attachmentsDir, { recursive: true });
      const source = await download.createReadStream();
      if (!source || this.closed) throw new Error("Download cancelled.");
      let sizeBytes = 0;
      await NodeStreamPromises.pipeline(
        source,
        new NodeStream.Transform({
          transform(chunk: Buffer, _encoding, callback) {
            sizeBytes += chunk.length;
            callback(
              sizeBytes > BROWSER_TRANSFER_MAX_BYTES ? new Error("Download exceeds 50 MiB.") : null,
              chunk,
            );
          },
        }),
        NodeFS.createWriteStream(partial, { flags: "wx", mode: 0o600 }),
      );
      if (this.closed) throw new Error("Download cancelled.");
      await NodeFSP.rename(partial, path);
      await this.remember({
        id,
        path,
        mimeType: "application/octet-stream",
        sizeBytes,
        createdAt: new Date().toISOString(),
        downloadName: name,
      });
      update({ status: "ready", attachmentId: id, sizeBytes });
    } catch (error) {
      await NodeFSP.rm(partial, { force: true });
      await NodeFSP.rm(path, { force: true });
      update({
        status: "failed",
        error: error instanceof Error ? error.message : "Download failed.",
      });
    } finally {
      await download.delete().catch(() => undefined);
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      await Promise.all([...this.downloads.keys()].map((d) => d.cancel().catch(() => undefined)));
      await Promise.allSettled(this.downloads.values());
      await this.dialog?.dismiss().catch(() => undefined);
      await (await this.cdp?.catch(() => null))?.detach().catch(() => undefined);
    })();
    return this.closing;
  }
}
