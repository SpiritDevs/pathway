import { useAuth } from "@clerk/react";
import { makeClerkConvexTokenFetcher } from "../../cloud/syncTransportAuth";
import { fetchConversationAttachment } from "./conversationAttachmentDrafts";
import { useConversationAttachmentDrafts } from "./conversationAttachmentDrafts";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { makeFunctionReference } from "convex/server";
import type { AiOrchestrator, OrchestratorChat } from "@spiritdevs/contracts/aiOrchestrator";
import { activeCompanyIdAtom } from "../../cloud/activeCompany";
import { useBusinessToolsCloud, useBusinessToolsQuery } from "../contacts/businessToolsCloud";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { resolveShortcutCommand } from "../../keybindings";
import { OrchestratorNotificationHost } from "./OrchestratorNotificationHost";
import { OrchestratorContext } from "./OrchestratorContext";

function useOrchestratorState() {
  const cloud = useBusinessToolsCloud();
  const { getToken } = useAuth();
  const attachments = useConversationAttachmentDrafts(cloud.client, cloud.accountID);
  const companyId = useAtomValue(activeCompanyIdAtom);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const pathname = useLocation({ select: (location) => location.pathname });
  const [floating, setFloating] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]"))
        return;
      if (resolveShortcutCommand(event, keybindings) !== "orchestrator.toggle") return;
      event.preventDefault();
      event.stopPropagation();
      setFloating((value) => !value);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings]);
  const [selectedId, selectChat] = useState<string | null>(null);
  const [settingsId, selectSettings] = useState<string | null>(null);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const pendingMessages = useRef(
    new Map<string, { id: string; text: string; targetId: string; attachmentIds: string[] }>(),
  );
  const [sendingChats, setSendingChats] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const scrollPositions = useRef(new Map<string, number>());
  const [error, setError] = useState<string>();
  const enabled =
    floating || pathname === "/orchestrator" || pathname.includes("/settings/orchestrators");
  const ownedContacts = useBusinessToolsQuery<AiOrchestrator[]>(
    cloud.client,
    cloud.accountID,
    "aiOrchestrators:list",
    enabled ? {} : null,
  );
  const companyContacts = useBusinessToolsQuery<AiOrchestrator[]>(
    cloud.client,
    cloud.accountID,
    "aiOrchestrators:list",
    enabled && companyId ? { companyId } : null,
  );
  const contacts = [
    ...new Map(
      [...(ownedContacts.value ?? []), ...(companyContacts.value ?? [])].map((contact) => [
        contact.id,
        contact,
      ]),
    ).values(),
  ];
  const conversations = useBusinessToolsQuery<OrchestratorChat[]>(
    cloud.client,
    cloud.accountID,
    "aiOrchestrators:listChats",
    {},
  );
  useEffect(() => {
    setFloating(false);
    selectChat(null);
    selectSettings(null);
    setDrafts({});
    pendingMessages.current.clear();
    setSendingChats([]);
    scrollPositions.current.clear();
    setError(undefined);
  }, [cloud.accountID]);
  const needsChief =
    ownedContacts.value !== undefined &&
    !ownedContacts.value.some(
      (contact) => contact.kind === "personal" && contact.ownerSubject === cloud.accountID,
    );
  useEffect(() => {
    if (!cloud.client || !needsChief) return;
    let current = true;
    void cloud.client
      .mutation(makeFunctionReference<"mutation">("aiOrchestrators:ensurePersonal"), {})
      .catch((cause: unknown) => {
        if (current) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      current = false;
    };
  }, [cloud.client, needsChief]);
  const chats = conversations.value ?? [];
  useEffect(() => {
    if (chats.some((chat) => chat.id === selectedId)) return;
    const initial = chats.find((chat) => !chat.archived);
    if (initial) selectChat(initial.id);
  }, [chats, selectedId]);
  useEffect(() => {
    const open = (event: Event) => {
      if (
        !(event instanceof CustomEvent) ||
        typeof event.detail !== "string" ||
        !chats.some((chat) => chat.id === event.detail)
      )
        return;
      selectChat(event.detail);
      setFloating(true);
    };
    window.addEventListener("pathway:open-orchestrator-chat", open);
    return () => window.removeEventListener("pathway:open-orchestrator-chat", open);
  }, [chats]);
  const selected =
    chats.find((chat) => chat.id === selectedId) ?? chats.find((chat) => !chat.archived) ?? null;
  const downloadAttachment = useCallback(
    async (id: string, signal?: AbortSignal) => {
      if (!cloud.client) throw new Error("Sign in to open this attachment.");
      const token = await makeClerkConvexTokenFetcher(getToken)({ forceRefreshToken: false });
      if (!token) throw new Error("Sign in to open this attachment.");
      return fetchConversationAttachment(cloud.client, id, token, signal);
    },
    [cloud.client, getToken],
  );
  return {
    ...cloud,
    attachments,
    downloadAttachment,
    companyId,
    floating,
    setFloating,
    selectedId: selected?.id ?? null,
    selectChat,
    selected,
    settingsId,
    selectSettings,
    newChatOpen,
    setNewChatOpen,
    contacts,
    chats,
    unreadCount: chats.filter((chat) => !chat.archived && chat.lastSequence > chat.readSequence)
      .length,
    loading: ownedContacts.value === undefined,
    error: error ?? ownedContacts.error ?? companyContacts.error ?? conversations.error,
    setError,
    drafts,
    pendingMessages,
    sendingChats,
    setSendingChat: (id: string, sending: boolean) =>
      setSendingChats((current) =>
        sending ? [...new Set([...current, id])] : current.filter((chatId) => chatId !== id),
      ),
    setDraft: (id: string, text: string) => setDrafts((current) => ({ ...current, [id]: text })),
    scrollPositions,
  };
}
export type OrchestratorState = ReturnType<typeof useOrchestratorState>;
export function OrchestratorProvider({ children }: { children: ReactNode }) {
  const value = useOrchestratorState();
  return (
    <OrchestratorContext value={value}>
      <OrchestratorNotificationHost />
      {children}
    </OrchestratorContext>
  );
}
