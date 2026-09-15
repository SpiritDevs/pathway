import type { OrchestratorReader } from "@spiritdevs/contracts/aiOrchestrator";
import { useOrchestrators } from "./OrchestratorContext";
import { OrchestratorAvatar } from "./OrchestratorAvatar";

export function ConversationReaders({ readers }: { readers: readonly OrchestratorReader[] }) {
  const { avatarContacts } = useOrchestrators();
  const names = readers.map((reader) => reader.name).join(", ");
  return (
    <span
      role="img"
      aria-label={`Read by ${names}`}
      title={`Read by ${names}`}
      className="inline-flex items-center -space-x-1"
    >
      {readers.slice(0, 4).map((reader) => {
        const contact =
          reader.kind === "orchestrator"
            ? avatarContacts.find((entry) => entry.id === reader.id)
            : undefined;
        return (
          <span
            key={`${reader.kind}:${reader.id}`}
            aria-hidden="true"
            className="inline-flex size-[18px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-[8px] font-medium text-muted-foreground ring-2 ring-popover"
          >
            {contact ? (
              <OrchestratorAvatar
                contact={{
                  name: contact.name,
                  color: contact.color,
                  ...(contact.avatar ? { avatar: contact.avatar } : {}),
                  ...(contact.personality ? { personality: contact.personality } : {}),
                }}
                className="size-[18px]"
              />
            ) : reader.imageUrl ? (
              <img
                src={reader.imageUrl}
                alt=""
                className="size-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              reader.name
                .trim()
                .split(/\s+/)
                .slice(0, 2)
                .map((part) => part[0])
                .join("")
                .toUpperCase()
            )}
          </span>
        );
      })}
      {readers.length > 4 && (
        <span aria-hidden="true" className="pl-2 text-[10px]">
          +{readers.length - 4}
        </span>
      )}
    </span>
  );
}
