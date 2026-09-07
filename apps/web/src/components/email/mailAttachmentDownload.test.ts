import { describe, expect, it, vi } from "vite-plus/test";
import { beginMailAttachmentDownload } from "./mailAttachmentDownload";

function deferredUrl() {
  let resolve!: (url: string) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<string>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function popup() {
  return { opener: {} as unknown, closed: false, close: vi.fn(), location: { replace: vi.fn() } };
}

describe("attachment downloads", () => {
  it("opens the browser tab synchronously before requesting its signed URL", async () => {
    const pending = deferredUrl();
    const tab = popup();
    const order: string[] = [];
    const download = beginMailAttachmentDownload({
      openWindow: () => {
        order.push("open");
        return tab;
      },
      resolveUrl: () => {
        order.push("request");
        return pending.promise;
      },
    });
    expect(order).toEqual(["open", "request"]);
    expect(tab.opener).toBeNull();
    expect(tab.location.replace).not.toHaveBeenCalled();
    pending.resolve("https://private-files.example.test/signed");
    await download.completed;
    expect(tab.location.replace).toHaveBeenCalledExactlyOnceWith(
      "https://private-files.example.test/signed",
    );
    download.cancel();
    expect(tab.close).not.toHaveBeenCalled();
  });
  it("explains popup blocking without requesting an attachment", async () => {
    const resolveUrl = vi.fn(async () => "unused");
    const download = beginMailAttachmentDownload({ openWindow: () => null, resolveUrl });
    await expect(download.completed).rejects.toThrow("Allow popups");
    expect(resolveUrl).not.toHaveBeenCalled();
  });
  it("closes a reserved blank tab when the relay request fails", async () => {
    const tab = popup();
    const download = beginMailAttachmentDownload({
      openWindow: () => tab,
      resolveUrl: async () => {
        throw new Error("Attachment unavailable");
      },
    });
    await expect(download.completed).rejects.toThrow("Attachment unavailable");
    expect(tab.close).toHaveBeenCalledOnce();
    expect(tab.location.replace).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "cancels an old message download before its request settles, failure=%s",
    async (fails) => {
      const tab = popup();
      const pending = deferredUrl();
      const download = beginMailAttachmentDownload({
        openWindow: () => tab,
        resolveUrl: () => pending.promise,
      });
      download.cancel();
      expect(tab.close).toHaveBeenCalledOnce();
      if (fails) pending.reject(new Error("Old scope failed"));
      else pending.resolve("https://private-files.example.test/old");
      await download.completed;
      expect(tab.location.replace).not.toHaveBeenCalled();
    },
  );
  it("keeps desktop downloads on the existing external-link IPC path", async () => {
    const openWindow = vi.fn();
    const openExternal = vi.fn(async () => {});
    const download = beginMailAttachmentDownload({
      openWindow,
      openExternal,
      resolveUrl: async () => "https://private-files.example.test/signed",
    });
    await download.completed;
    expect(openWindow).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(
      "https://private-files.example.test/signed",
    );
  });
  it("does not open a late desktop download after leaving the message", async () => {
    const pending = deferredUrl();
    const openExternal = vi.fn(async () => {});
    const download = beginMailAttachmentDownload({
      openWindow: () => null,
      openExternal,
      resolveUrl: () => pending.promise,
    });
    download.cancel();
    pending.resolve("https://private-files.example.test/old");
    await download.completed;
    expect(openExternal).not.toHaveBeenCalled();
  });
});
