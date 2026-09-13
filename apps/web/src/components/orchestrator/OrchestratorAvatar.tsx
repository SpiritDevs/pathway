import { BotIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import type { AiOrchestrator } from "@spiritdevs/contracts/aiOrchestrator";

export const ORCHESTRATOR_COLORS = {
  violet: "bg-violet-500",
  blue: "bg-blue-500",
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  pink: "bg-pink-500",
  cyan: "bg-cyan-600",
};
export function OrchestratorAvatar({
  contact,
  className,
}: {
  contact?: Pick<AiOrchestrator, "name" | "color"> | undefined;
  className?: string | undefined;
}) {
  const color =
    ORCHESTRATOR_COLORS[contact?.color as keyof typeof ORCHESTRATOR_COLORS] ??
    ORCHESTRATOR_COLORS.violet;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-full text-white shadow-inner",
        color,
        className,
      )}
    >
      <BotIcon className="size-[52%]" strokeWidth={1.7} />
    </span>
  );
}
export function ConversationAvatar({
  contacts,
  className,
}: {
  contacts: readonly AiOrchestrator[];
  className?: string;
}) {
  if (contacts.length <= 1)
    return <OrchestratorAvatar contact={contacts[0]} className={className} />;
  return (
    <span className={cn("flex shrink-0 -space-x-4", className)}>
      {contacts.slice(0, 3).map((contact) => (
        <OrchestratorAvatar
          key={contact.id}
          contact={contact}
          className="size-9 ring-2 ring-background"
        />
      ))}
    </span>
  );
}
