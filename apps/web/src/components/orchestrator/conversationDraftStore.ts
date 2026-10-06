/** Drafts survive composer remounts; only the composer for that chat subscribes. */
export function createConversationDraftStore() {
  const drafts = new Map<string, string>();
  const listeners = new Map<string, Set<() => void>>();
  const get = (chatId: string) => drafts.get(chatId) ?? "";
  const set = (chatId: string, text: string) => {
    if (get(chatId) === text) return;
    if (text) drafts.set(chatId, text);
    else drafts.delete(chatId);
    listeners.get(chatId)?.forEach((listener) => listener());
  };
  return {
    get,
    set,
    subscribe: (chatId: string, listener: () => void) => {
      let subscribers = listeners.get(chatId);
      if (!subscribers) {
        subscribers = new Set();
        listeners.set(chatId, subscribers);
      }
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) listeners.delete(chatId);
      };
    },
    clear: () => {
      const chatIds = [...drafts.keys()];
      drafts.clear();
      for (const chatId of chatIds) listeners.get(chatId)?.forEach((listener) => listener());
    },
  };
}
