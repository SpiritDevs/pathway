import type { AiOrchestrator, OrchestratorChat } from "@spiritdevs/contracts/aiOrchestrator";

/** Explicit selections may open archives; automatic entry only uses available conversations. */
export function defaultConversation(
  chats: readonly OrchestratorChat[],
  contacts: readonly AiOrchestrator[],
  accountID: string,
  selected: { accountID: string; id: string | null } | null,
  rememberedId: string | null,
  identities: readonly Partial<Pick<AiOrchestrator, "id" | "status">>[] = contacts,
) {
  const readable = (chat: OrchestratorChat) =>
    chat.lifecycle !== "deleted" &&
    chat.lifecycle !== "deleting" &&
    chat.orchestratorIds.every((id) =>
      identities.some((contact) => contact.id === id && contact.status !== "deleted"),
    );
  const explicit =
    selected?.accountID === accountID
      ? chats.find((chat) => chat.id === selected.id && readable(chat))
      : undefined;
  if (explicit) return explicit;
  const available = (chat: OrchestratorChat) =>
    readable(chat) &&
    !chat.archived &&
    !chat.lifecycle &&
    chat.orchestratorIds.every((id) => {
      const contact = identities.find((item) => item.id === id);
      return contact && contact.status !== "deleted" && contact.status !== "archived";
    });
  const remembered = chats.find((chat) => chat.id === rememberedId && available(chat));
  if (remembered) return remembered;
  const personal = contacts.find(
    (contact) =>
      contact.ownerSubject === accountID &&
      contact.kind === "personal" &&
      !contact.shared &&
      !contact.companyId &&
      (contact.status === "active" || contact.status === "paused"),
  );
  return (
    chats.find(
      (chat) =>
        available(chat) &&
        chat.kind === "dm" &&
        chat.leadId === personal?.id &&
        chat.companyIds.length === 0 &&
        chat.orchestratorIds.length === 1 &&
        chat.participantSubjects.length === 1 &&
        chat.participantSubjects[0] === accountID,
    ) ?? null
  );
}

export function rememberedConversation(accountID: string) {
  try {
    return localStorage.getItem(`pathway:orchestrator:last-chat:${accountID}`);
  } catch {
    return null;
  }
}
export function rememberConversation(accountID: string, id: string) {
  try {
    localStorage.setItem(`pathway:orchestrator:last-chat:${accountID}`, id);
  } catch {
    /* Navigation still works when storage is unavailable. */
  }
}
