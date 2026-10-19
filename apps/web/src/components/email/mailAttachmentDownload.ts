interface DownloadWindow {
  opener: unknown;
  readonly closed: boolean;
  readonly location: { replace: (url: string) => void };
  close: () => void;
}

/** Reserve a browser tab inside the click before requesting the short-lived attachment URL. */
export function beginMailAttachmentDownload({
  resolveUrl,
  openWindow,
  openExternal,
}: {
  resolveUrl: () => Promise<string>;
  openWindow: () => DownloadWindow | null;
  openExternal?: (url: string) => Promise<void>;
}) {
  const popup = openExternal ? null : openWindow();
  if (!openExternal && !popup) {
    return {
      completed: Promise.reject(new Error("Allow popups to download attachments, then retry.")),
      cancel: () => {},
    };
  }
  if (popup) popup.opener = null;
  let active = true;
  let pending = true;
  const completed = (async () => {
    try {
      const url = await resolveUrl();
      if (!active) return;
      if (openExternal) await openExternal(url);
      else if (popup && !popup.closed) popup.location.replace(url);
      else throw new Error("The download tab was closed. Select the attachment to try again.");
    } catch (cause) {
      if (active) {
        popup?.close();
        throw cause;
      }
    } finally {
      pending = false;
    }
  })();
  return {
    completed,
    cancel: () => {
      active = false;
      if (pending) popup?.close();
    },
  };
}
