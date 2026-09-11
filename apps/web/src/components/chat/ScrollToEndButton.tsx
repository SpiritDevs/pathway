import { ChevronDownIcon } from "lucide-react";
import { ThinkingOrb } from "thinking-orbs";

export function ScrollToEndButton({
  isWorking,
  theme,
  onClick,
}: {
  isWorking: boolean;
  theme: "light" | "dark";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={isWorking ? "Scroll to end, agent working" : "Scroll to end"}
      title="Scroll to end"
      onClick={onClick}
      className={`chat-composer-glass pointer-events-auto flex h-8 items-center justify-center gap-1.5 rounded-full border border-border/60 text-muted-foreground text-xs shadow-sm transition-colors hover:border-border hover:text-foreground hover:cursor-pointer ${isWorking ? "px-3" : "w-8"}`}
    >
      {isWorking ? (
        <>
          <ThinkingOrb state="working" size={20} theme={theme} aria-hidden="true" />
          <span>working...</span>
        </>
      ) : (
        <ChevronDownIcon className="size-3.5" aria-hidden="true" />
      )}
    </button>
  );
}
