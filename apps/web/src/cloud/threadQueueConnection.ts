/** Recreate query subscriptions after a disconnect; cached values are not a fresh queue. */
export function watchQueueConnection(
  client: {
    connectionState(): { isWebSocketConnected: boolean };
    subscribeToConnectionState(
      receive: (state: { isWebSocketConnected: boolean }) => void,
    ): () => void;
  },
  invalidate: () => void,
  connected: () => void,
) {
  let wasConnected = client.connectionState().isWebSocketConnected;
  let invalidated = false;
  return client.subscribeToConnectionState((state) => {
    if (invalidated) return;
    if (wasConnected && !state.isWebSocketConnected) {
      invalidated = true;
      invalidate();
      return;
    }
    wasConnected = state.isWebSocketConnected;
    if (wasConnected) connected();
  });
}

/** An interrupted mutation may have succeeded; release UI controls without retrying it. */
export function awaitQueueMutation<T>(mutation: Promise<T>, closed: Promise<void>): Promise<T> {
  return Promise.race([
    mutation,
    closed.then(() => {
      throw new Error("Connection changed. Check the thread state before retrying.");
    }),
  ]);
}
