// @effect-diagnostics nodeBuiltinImport:off - Browser adapter tests use a fake page and isolated files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Dialog, Download, FileChooser, Frame, Page } from "playwright";
import { PreviewTabId, ThreadId, type PreviewRemoteInteractionState } from "@spiritdevs/contracts";
import { createPendingAttachmentId, createAttachmentId } from "../attachmentStore.ts";
import { RemoteBrowserInteractions } from "./RemoteBrowserInteractions.ts";

const target = { threadId: ThreadId.make("input-test"), tabId: PreviewTabId.make("tab") };
const authorize = async () => undefined;
function fixture(
  directory: string,
  changed = () => undefined,
  remember = vi.fn(async () => undefined),
) {
  const events = new NodeEvents.EventEmitter();
  const cdp = { send: vi.fn(async () => undefined), detach: vi.fn(async () => undefined) };
  const context = {
    grantPermissions: vi.fn(async () => undefined),
    newCDPSession: vi.fn(async () => cdp),
  };
  const frame = { evaluate: vi.fn(async (_expression: string) => undefined) };
  const page = {
    on: events.on.bind(events),
    url: () => "https://example.com/page",
    frames: () => [frame],
    mainFrame: () => frame,
    exposeBinding: vi.fn(async () => undefined),
    addInitScript: vi.fn(async () => undefined),
    evaluate: vi.fn(async (expression: string) =>
      expression.includes("readText") ? "remote clipboard" : undefined,
    ),
    context: () => context,
    mouse: { move: vi.fn(async () => undefined) },
  };
  const interactions = new RemoteBrowserInteractions(
    page as unknown as Page,
    target.threadId,
    target.tabId,
    directory,
    changed,
    remember,
  );
  return { interactions, events, page, frame, context, cdp, remember };
}
describe("remote browser interactions", () => {
  let directory: string;
  const active: RemoteBrowserInteractions[] = [];
  beforeEach(async () => {
    directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-browser-input-"));
  });
  afterEach(async () => {
    await Promise.all(active.splice(0).map((i) => i.close()));
    await NodeFSP.rm(directory, { recursive: true, force: true });
  });
  const keep = (f: ReturnType<typeof fixture>) => {
    active.push(f.interactions);
    return f;
  };

  it("replays an open dialog without evaluating blocked page JS, replies once, and dismisses on unwatch", async () => {
    const f = keep(fixture(directory));
    await f.interactions.watch(true);
    const dialog = {
      type: () => "prompt",
      message: () => "Name?",
      defaultValue: () => "initial",
      accept: vi.fn(async () => undefined),
      dismiss: vi.fn(async () => undefined),
    };
    f.events.emit("dialog", dialog as unknown as Dialog);
    const pending = f.interactions.state.dialog!;
    expect(pending).toMatchObject({ kind: "prompt", message: "Name?", defaultValue: "initial" });
    f.frame.evaluate.mockImplementation(() => new Promise(() => undefined));
    await f.interactions.watch(true);
    expect(f.interactions.state.dialog).toEqual(pending);
    await f.interactions.command(
      {
        ...target,
        action: "dialogRespond",
        dialogId: pending.dialogId,
        accept: true,
        promptText: "Corey",
      },
      authorize,
    );
    expect(dialog.accept).toHaveBeenCalledWith("Corey");
    expect(f.interactions.state.dialog).toBeNull();
    await expect(
      f.interactions.command(
        { ...target, action: "dialogRespond", dialogId: pending.dialogId, accept: false },
        authorize,
      ),
    ).rejects.toThrow("no longer");
    f.events.emit("dialog", dialog);
    await f.interactions.watch(false);
    expect(dialog.dismiss).toHaveBeenCalledOnce();
  });

  it.each(["alert", "confirm", "beforeunload"] as const)(
    "surfaces and dismisses %s dialogs",
    async (kind) => {
      const f = keep(fixture(directory));
      await f.interactions.watch(true);
      const dismiss = vi.fn(async () => undefined);
      f.events.emit("dialog", {
        type: () => kind,
        message: () => "Message",
        defaultValue: () => "",
        dismiss,
      });
      const pending = f.interactions.state.dialog!;
      expect(pending.kind).toBe(kind);
      await f.interactions.command(
        { ...target, action: "dialogRespond", dialogId: pending.dialogId, accept: false },
        authorize,
      );
      expect(dismiss).toHaveBeenCalledOnce();
    },
  );

  it("moves clipboard text in both directions and reports copied text and validated cursors", async () => {
    const changed = vi.fn();
    const f = keep(fixture(directory, changed));
    await f.interactions.install();
    await f.interactions.watch(true);
    expect(f.page.addInitScript).toHaveBeenCalledOnce();
    await f.interactions.command(
      { ...target, action: "clipboardWrite", text: "local\nclipboard" },
      authorize,
    );
    expect(f.page.evaluate).toHaveBeenCalledWith(
      'navigator.clipboard.writeText("local\\nclipboard")',
    );
    expect(f.interactions.state.clipboard).toBe("local\nclipboard");
    await f.interactions.command({ ...target, action: "clipboardRead" }, authorize);
    expect(f.interactions.state.clipboard).toBe("remote clipboard");
    expect(f.context.grantPermissions).toHaveBeenCalledWith(["clipboard-read", "clipboard-write"], {
      origin: "https://example.com",
    });
    f.interactions.onBridge(f.frame as unknown as Frame, {
      type: "clipboard",
      text: "copied in browser",
    });
    f.interactions.onBridge(f.frame as unknown as Frame, { type: "cursor", cursor: "pointer" });
    expect(f.interactions.state).toMatchObject({
      clipboard: "copied in browser",
      cursor: "pointer",
    });
    const count = changed.mock.calls.length;
    f.interactions.onBridge(f.frame as unknown as Frame, { type: "cursor", cursor: "pointer" });
    f.interactions.onBridge(f.frame as unknown as Frame, {
      type: "cursor",
      cursor: "url(https://bad)",
    });
    expect(changed).toHaveBeenCalledTimes(count);
  });

  it("provides uploaded attachment bytes with original names and rejects foreign/stale chooser responses", async () => {
    const f = keep(fixture(directory));
    await f.interactions.watch(true);
    const chooser = { isMultiple: () => false, setFiles: vi.fn(async () => undefined) };
    f.events.emit("filechooser", chooser as unknown as FileChooser);
    const chooserId = f.interactions.state.fileChooser!.chooserId;
    const attachmentId = createPendingAttachmentId("txt");
    await NodeFSP.writeFile(NodePath.join(directory, `${attachmentId}.txt`), "payload");
    const input = {
      ...target,
      action: "fileChooserRespond" as const,
      chooserId,
      files: [{ attachmentId, name: "original.txt", mimeType: "text/plain" }],
    };
    const denied = {
      ...input,
      files: [{ ...input.files[0]!, attachmentId: createAttachmentId("other-thread", "txt")! }],
    };
    await expect(f.interactions.command(denied, authorize)).rejects.toThrow("another task");
    await f.interactions.command(input, authorize);
    expect(chooser.setFiles).toHaveBeenCalledWith([
      { name: "original.txt", mimeType: "text/plain", buffer: Buffer.from("payload") },
    ]);
    expect(f.interactions.state.fileChooser).toBeNull();
    await expect(f.interactions.command(input, authorize)).rejects.toThrow("no longer");
    f.events.emit("filechooser", chooser);
    await f.interactions.command(
      { ...input, chooserId: f.interactions.state.fileChooser!.chooserId, files: [] },
      authorize,
    );
    expect(chooser.setFiles).toHaveBeenLastCalledWith([]);
  });

  it("rejects an oversized uploaded file before reading or sending it to the page", async () => {
    const f = keep(fixture(directory));
    await f.interactions.watch(true);
    const chooser = { isMultiple: () => true, setFiles: vi.fn(async () => undefined) };
    f.events.emit("filechooser", chooser);
    const attachmentId = createPendingAttachmentId("bin");
    const path = NodePath.join(directory, `${attachmentId}.bin`);
    await NodeFSP.writeFile(path, "");
    await NodeFSP.truncate(path, 50 * 1024 * 1024 + 1);
    await expect(
      f.interactions.command(
        {
          ...target,
          action: "fileChooserRespond",
          chooserId: f.interactions.state.fileChooser!.chooserId,
          files: [{ attachmentId, name: "large.bin", mimeType: "application/octet-stream" }],
        },
        authorize,
      ),
    ).rejects.toThrow("50 MiB");
    expect(chooser.setFiles).not.toHaveBeenCalled();
  });

  it("does not apply an upload if control changes during attachment IO", async () => {
    const f = keep(fixture(directory));
    await f.interactions.watch(true);
    const chooser = { isMultiple: () => true, setFiles: vi.fn(async () => undefined) };
    f.events.emit("filechooser", chooser);
    const attachmentId = createPendingAttachmentId("txt");
    await NodeFSP.writeFile(NodePath.join(directory, `${attachmentId}.txt`), "payload");
    const check = vi
      .fn(async () => undefined)
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        throw new Error("Take control");
      });
    await expect(
      f.interactions.command(
        {
          ...target,
          action: "fileChooserRespond",
          chooserId: f.interactions.state.fileChooser!.chooserId,
          files: [{ attachmentId, name: "file", mimeType: "text/plain" }],
        },
        check,
      ),
    ).rejects.toThrow("Take control");
    expect(chooser.setFiles).not.toHaveBeenCalled();
  });

  it("routes select choices to the originating frame and clears stale navigation state", async () => {
    const f = keep(fixture(directory));
    await f.interactions.watch(true);
    const message = {
      type: "select",
      selectId: "select-id",
      multiple: false,
      options: [{ index: 0, label: "Zero", value: "0", disabled: false, selected: true }],
    };
    f.interactions.onBridge(f.frame as unknown as Frame, message);
    expect(f.interactions.state.select?.options).toEqual(message.options);
    await f.interactions.command(
      { ...target, action: "selectChoose", selectId: "select-id", indices: [0] },
      authorize,
    );
    expect(f.frame.evaluate.mock.calls.at(-1)?.[0]).toContain('"indices":[0]');
    expect(f.interactions.state.select).toBeNull();
    f.interactions.onBridge(f.frame as unknown as Frame, message);
    f.events.emit("framenavigated", f.frame);
    await expect(
      f.interactions.command(
        { ...target, action: "selectChoose", selectId: "select-id", indices: null },
        authorize,
      ),
    ).rejects.toThrow("no longer");
  });

  it("dispatches IME composition and fractional trackpad deltas without creating capture", async () => {
    const f = keep(fixture(directory));
    for (const phase of ["update", "commit", "cancel"] as const)
      await f.interactions.command(
        {
          ...target,
          action: "composition",
          phase,
          text: "日本",
          selectionStart: 0,
          selectionEnd: 2,
        },
        authorize,
      );
    expect(f.cdp.send).toHaveBeenCalledWith("Input.imeSetComposition", {
      text: "日本",
      selectionStart: 0,
      selectionEnd: 2,
    });
    expect(f.cdp.send).toHaveBeenCalledWith("Input.insertText", { text: "日本" });
    expect(f.cdp.send).toHaveBeenCalledWith("Input.imeSetComposition", {
      text: "",
      selectionStart: 0,
      selectionEnd: 0,
    });
    await f.interactions.command(
      { ...target, action: "wheel", x: 10, y: 20, deltaX: 0.25, deltaY: -1.5, modifiers: 2 },
      authorize,
    );
    expect(f.cdp.send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 10,
      y: 20,
      deltaX: 0.25,
      deltaY: -1.5,
      modifiers: 2,
    });
    await f.interactions.command({ ...target, action: "pointerMove", x: 1, y: 2 }, authorize);
    expect(f.page.mouse.move).toHaveBeenCalledWith(1, 2);
    expect(f.context.newCDPSession).toHaveBeenCalledOnce();
    await expect(
      f.interactions.command(
        {
          ...target,
          action: "composition",
          phase: "update",
          text: "x",
          selectionStart: 0,
          selectionEnd: 2,
        },
        authorize,
      ),
    ).rejects.toThrow("selection");
  });

  it("streams downloads into retained attachments and emits ready or failed state", async () => {
    const completed = Promise.withResolvers<PreviewRemoteInteractionState>();
    const f = keep(
      fixture(directory, () => {
        if (f.interactions.state.downloads.some((d) => d.status === "ready"))
          completed.resolve(f.interactions.state);
      }),
    );
    const download = {
      suggestedFilename: () => "report.csv",
      createReadStream: async () => NodeStream.Readable.from([Buffer.from("a,b\n1,2")]),
      cancel: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    f.events.emit("download", download as unknown as Download);
    const ready = (await completed.promise).downloads[0]!;
    expect(ready).toMatchObject({ name: "report.csv", status: "ready", sizeBytes: 7 });
    expect(
      await NodeFSP.readFile(NodePath.join(directory, `${ready.attachmentId}.bin`), "utf8"),
    ).toBe("a,b\n1,2");
    expect(f.remember).toHaveBeenCalledWith(
      expect.objectContaining({ id: ready.attachmentId, downloadName: "report.csv" }),
    );
    const failed = Promise.withResolvers<void>();
    const g = keep(
      fixture(directory, () => {
        if (g.interactions.state.downloads.some((d) => d.status === "failed")) failed.resolve();
      }),
    );
    g.events.emit("download", {
      ...download,
      createReadStream: async () => {
        throw new Error("Network interrupted");
      },
    });
    await failed.promise;
    expect(g.interactions.state.downloads[0]!.error).toContain("Network interrupted");
  });
});
