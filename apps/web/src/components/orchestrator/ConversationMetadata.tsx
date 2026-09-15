import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ChevronRightIcon,
  MonitorIcon,
  PanelRightIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react";
import type { OrchestratorChat, OrchestratorWorkItem } from "@spiritdevs/contracts/aiOrchestrator";
import { scopeThreadRef } from "@spiritdevs/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { useOrchestrators } from "./OrchestratorContext";
import { OrchestratorAvatar } from "./OrchestratorAvatar";
import { ConversationParticipants } from "./ConversationParticipants";

export function WorkList({ items }: { items: readonly OrchestratorWorkItem[] }) {
  const navigate = useNavigate();
  const state = useOrchestrators();
  return (
    <div className="divide-y">
      {items.map((item) => (
        <div key={item.id} className="flex items-start gap-3 py-3">
          <span
            className={cn(
              "mt-1.5 size-2 shrink-0 rounded-full",
              item.status === "working" || item.status === "completed"
                ? "bg-emerald-500"
                : item.status === "queued"
                  ? "bg-amber-500"
                  : item.status === "failed"
                    ? "bg-red-500"
                    : "bg-muted-foreground/50",
            )}
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{item.title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{item.detail || item.status}</p>
            {item.selection && (
              <p className="mt-1 text-xs text-muted-foreground">
                {item.selection.instanceId} / {item.selection.model}
                {(item.selection.options ?? [])
                  .map((option) => ` · ${option.id}: ${option.value}`)
                  .join("")}
              </p>
            )}
            {item.selectionReason && (
              <p className="mt-1 text-xs text-muted-foreground">{item.selectionReason}</p>
            )}
            {item.threadId && (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 [&>button]:whitespace-nowrap">
                <button
                  type="button"
                  className="text-xs text-blue-500 hover:underline"
                  onClick={() =>
                    state.selectedId &&
                    state.setReply(state.selectedId, {
                      kind: "worker",
                      name: item.title,
                      text: "Your message will go to this worker’s existing thread.",
                      workId: item.id,
                      orchestratorId: item.orchestratorId,
                    })
                  }
                >
                  Message worker
                </button>
                {["working", "queued", "unknown"].includes(item.status) && (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      void state
                        .request("aiOrchestratorControls:stop", {
                          chatId: state.selectedId,
                          workId: item.id,
                        })
                        .catch((cause) =>
                          state.setError(cause instanceof Error ? cause.message : String(cause)),
                        );
                    }}
                  >
                    Stop work
                  </button>
                )}
                <button
                  type="button"
                  className="text-xs text-blue-500 hover:underline"
                  onClick={() => {
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(
                        scopeThreadRef(
                          EnvironmentId.make(item.environmentId),
                          ThreadId.make(item.threadId!),
                        ),
                      ),
                    });
                  }}
                >
                  Open thread
                </button>
              </div>
            )}
          </div>
          <span className="pt-0.5 text-xs capitalize text-muted-foreground">{item.status}</span>
        </div>
      ))}
    </div>
  );
}
export function ConversationMetadata({
  chat,
  work,
  onClose,
  onFloat,
  floating,
  companion = false,
}: {
  chat: OrchestratorChat;
  work: readonly OrchestratorWorkItem[];
  onClose: () => void;
  onFloat: () => void;
  floating: boolean;
  companion?: boolean;
}) {
  const state = useOrchestrators();
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const contacts = state.contacts.filter((contact) => chat.orchestratorIds.includes(contact.id));
  const eligibleIds = new Set(contacts.flatMap((contact) => contact.environmentIds));
  const eligible = contacts.some((contact) => contact.allEnvironments)
    ? environments
    : environments.filter((environment) => eligibleIds.has(environment.environmentId));
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div
        className={cn(
          "flex shrink-0 items-center gap-2 border-b px-5",
          companion ? "h-14" : "h-20",
        )}
      >
        <h2 className="flex-1 text-sm font-semibold">Conversation details</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label={floating ? "Dock conversation details" : "Float conversation details"}
          onClick={onFloat}
        >
          <PanelRightIcon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close conversation details"
          onClick={onClose}
        >
          <XIcon className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-7 overflow-y-auto p-5">
        <section>
          <h3 className="mb-4 text-xs font-semibold text-muted-foreground">IN THIS CONVERSATION</h3>
          <div className="space-y-3">
            {contacts.map((contact) => (
              <div key={contact.id} className="flex items-center gap-3">
                <OrchestratorAvatar contact={contact} className="size-9" />
                <div className="flex-1">
                  <p className="text-sm font-medium">{contact.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {contact.id === chat.leadId
                      ? "Conversation lead"
                      : contact.kind === "project"
                        ? "Project coordinator"
                        : "Orchestrator"}
                  </p>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Settings for ${contact.name}`}
                  onClick={() => {
                    state.selectSettings(contact.id);
                    void navigate({ to: "/settings/orchestrators-overview" });
                  }}
                >
                  <ChevronRightIcon className="size-4" />
                </Button>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            {chat.participantSubjects.length === 1
              ? "You"
              : `${chat.participantSubjects.length} people`}{" "}
            · {contacts.length} orchestrator{contacts.length === 1 ? "" : "s"}
          </p>
          <ConversationParticipants chat={chat} />
        </section>
        <section className="border-t pt-5">
          <h3 className="text-xs font-semibold text-muted-foreground">SHARED WORK</h3>
          {work.length ? (
            <WorkList items={work} />
          ) : (
            <p className="py-4 text-sm leading-relaxed text-muted-foreground">
              Delegated work and its progress will appear here.
            </p>
          )}
        </section>
        <section className="border-t pt-5">
          <h3 className="mb-3 text-xs font-semibold text-muted-foreground">ENVIRONMENTS</h3>
          {eligible.map((environment) => (
            <div key={environment.environmentId} className="flex items-center gap-3 py-3 text-sm">
              <MonitorIcon className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{environment.label}</span>
              <span
                className={cn(
                  "size-2 rounded-full",
                  environment.connection.phase === "connected"
                    ? "bg-emerald-500"
                    : "bg-muted-foreground/60",
                )}
              />
              <span className="text-xs text-muted-foreground">
                {environment.connection.phase === "connected"
                  ? "Connected"
                  : environment.connection.phase === "reconnecting"
                    ? "Reconnecting"
                    : "Offline"}
              </span>
            </div>
          ))}
          {eligible.length === 0 && (
            <p className="text-sm leading-relaxed text-muted-foreground">
              No environment connected. Messages can wait here until one is ready.
            </p>
          )}
        </section>
        <section className="border-t pt-4">
          <Button
            variant="ghost"
            className="w-full justify-start"
            onClick={() => {
              state.selectSettings(chat.leadId);
              void navigate({ to: "/settings/orchestrators-permissions" });
            }}
          >
            <SettingsIcon />
            Manage permissions
          </Button>
          {chat.ownerSubject === state.accountID && (
            <Button
              variant="ghost"
              className="w-full justify-start"
              onClick={() => {
                void state
                  .request("aiOrchestrators:updateChat", {
                    chatId: chat.id,
                    archived: !chat.archived,
                  })
                  .catch((cause: unknown) =>
                    state.setError(cause instanceof Error ? cause.message : String(cause)),
                  );
              }}
            >
              <ArchiveIcon />
              {chat.archived ? "Unarchive conversation" : "Archive conversation"}
            </Button>
          )}
        </section>
      </div>
    </div>
  );
}
