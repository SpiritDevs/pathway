export interface AlertLockManager {
  request(
    name: string,
    options: { mode: "exclusive"; signal: AbortSignal },
    callback: () => Promise<void>,
  ): Promise<unknown>;
}

/** A disconnected tab gives its delivery lease back before releasing the browser lock. */
export function createThreadAlertLeadership(input: {
  readonly name: string;
  readonly locks: AlertLockManager | undefined;
  readonly onChange: (ownsLock: boolean) => void;
  readonly releaseLease: () => Promise<void>;
}) {
  let connected = false;
  let disposed = false;
  type LockAttempt = { abort: AbortController; release?: () => void };
  let attempt: LockAttempt | null = null;
  let releasing = Promise.resolve();
  const begin = () => {
    if (!connected || disposed || attempt) return;
    const current: LockAttempt = { abort: new AbortController() };
    attempt = current;
    if (!input.locks) {
      input.onChange(true);
      return;
    }
    void input.locks
      .request(input.name, { mode: "exclusive", signal: current.abort.signal }, async () => {
        if (attempt !== current || !connected || disposed) return;
        const held = new Promise<void>((resolve) => {
          current.release = resolve;
        });
        input.onChange(true);
        await held;
      })
      .catch(() => {
        // The IndexedDB lease still coordinates tabs when the platform rejects Web Locks.
        if (attempt === current && connected && !disposed) input.onChange(true);
      });
  };
  const release = () => {
    const current = attempt;
    attempt = null;
    current?.abort.abort();
    input.onChange(false);
    releasing = releasing
      .then(input.releaseLease)
      .catch(() => {})
      .then(() => current?.release?.());
    return releasing;
  };
  return {
    setConnected(value: boolean): Promise<void> {
      if (connected === value || disposed) return releasing;
      connected = value;
      if (!value) return release();
      return releasing.then(begin);
    },
    dispose(): Promise<void> {
      disposed = true;
      connected = false;
      return release();
    },
  };
}
