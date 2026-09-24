// FILE: binaryFrameSource.ts
// Purpose: Deliver encoded frames (computer desktop captures) from the server
// to a pane's decoder over a dedicated binary WebSocket.
// Layer: Web transport helper
// Exports: the shared frame-source mechanism; the computer module wraps it with
// its route constants and decoder.

export type FrameSourceResetReason = "closed" | "error" | "decode-failed";

/** The narrow slice of WebSocket the frame path uses, so tests need no DOM. */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState?: number;
  readonly send: (data: string) => void;
  readonly close: () => void;
  readonly addEventListener: (
    type: "message" | "close" | "error" | "open",
    listener: (event: never) => void,
  ) => void;
}

interface BinaryFrameSourceOptions<Frame> {
  /**
   * Fully resolved socket URL: route, stream id, and (for remote connections)
   * a short-lived ticket. Frames are lossy, high-rate, and useless the moment
   * they are late, so they ride this dedicated socket rather than the RPC
   * socket: a frame burst can never delay an RPC response or a domain-event
   * push, and a slow consumer drops frames instead of stalling the control
   * plane. The subscription is the URL, so frames start with no handshake.
   */
  readonly url: string;
  readonly resyncMessage: string;
  readonly handlers: {
    readonly onFrame: (frame: Frame) => void;
    /**
     * The socket dropped. The pane resets its decoder because the next
     * connection starts a new stream generation with its own parameter sets.
     */
    readonly onReset: (reason: FrameSourceResetReason) => void;
  };
  /** Test seam; defaults to the browser's WebSocket. */
  readonly createSocket?: (url: string) => WebSocketLike;
  readonly decode: (
    bytes: Uint8Array,
  ) =>
    | { readonly ok: true; readonly frame: Frame }
    | { readonly ok: false; readonly reason: unknown };
  /** Test seam for the resync cooldown clock. */
  readonly now?: () => number;
  /**
   * Rebuilding a capture session is expensive (the computer route re-primes
   * compositor capture), so a gate that fires on every dropped frame must not
   * be allowed to thrash it. One request is in flight at a time and further
   * requests inside this window are dropped rather than queued — the resync
   * already in flight will deliver the keyframe they wanted.
   */
  readonly resyncCooldownMs: number;
}

export interface BinaryFrameSource {
  /**
   * Ask the server for a fresh keyframe after a gap or decode error.
   * Debounced; returns true when the request actually went out.
   */
  readonly requestResync: () => boolean;
  /** Idempotent; a source is single-use and cannot be restarted after close. */
  readonly close: () => void;
}

export function createBinaryFrameSource<Frame>(
  options: BinaryFrameSourceOptions<Frame>,
): BinaryFrameSource {
  const socket = (options.createSocket ?? defaultCreateSocket)(options.url);
  socket.binaryType = "arraybuffer";

  const now = options.now ?? (() => Date.now());
  let closed = false;
  let open = false;
  let lastResyncAt: number | null = null;
  // A gap can be detected before the socket finishes opening (the first frames
  // of a fresh connection). Remember the intent and send it on open rather than
  // dropping it, or the canvas waits for the server's next natural keyframe.
  let resyncPending = false;

  const reset = (reason: FrameSourceResetReason) => {
    if (closed) return;
    options.handlers.onReset(reason);
  };

  const sendResync = (): boolean => {
    if (closed) return false;
    try {
      socket.send(JSON.stringify({ type: options.resyncMessage }));
      return true;
    } catch {
      // A socket that dropped between the readyState check and the send; the
      // close handler already resets the decoder.
      return false;
    }
  };

  socket.addEventListener("open", (() => {
    open = true;
    if (!resyncPending) return;
    resyncPending = false;
    sendResync();
  }) as (event: never) => void);

  socket.addEventListener("message", ((event: { data: unknown }) => {
    if (closed) return;
    const bytes = frameBytes(event.data);
    // Text on this socket is a protocol violation, not a frame; ignoring it
    // keeps a stray server log line from tearing down a healthy stream.
    if (!bytes) return;

    const result = options.decode(bytes);
    if (!result.ok) {
      // A malformed envelope means the two sides disagree about the wire format.
      // Resetting the decoder is the only safe response; the payload after a bad
      // header cannot be trusted to be a valid frame.
      reset("decode-failed");
      return;
    }
    options.handlers.onFrame(result.frame);
  }) as (event: never) => void);

  socket.addEventListener("close", (() => reset("closed")) as (event: never) => void);
  socket.addEventListener("error", (() => reset("error")) as (event: never) => void);

  return {
    requestResync: () => {
      if (closed) return false;
      const at = now();
      if (lastResyncAt !== null && at - lastResyncAt < options.resyncCooldownMs) {
        return false;
      }
      lastResyncAt = at;
      if (!open) {
        resyncPending = true;
        return false;
      }
      return sendResync();
    },
    close: () => {
      if (closed) return;
      closed = true;
      resyncPending = false;
      try {
        socket.close();
      } catch {
        // Some browsers throw when closing a socket that never opened.
      }
    },
  };
}

/**
 * Normalizes a binary WebSocket payload to bytes. Blob delivery is async and
 * would reorder frames against ArrayBuffer delivery, so the socket is pinned to
 * `arraybuffer` and a Blob here means a misconfigured socket rather than a
 * frame worth rescuing.
 */
function frameBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

function defaultCreateSocket(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}
