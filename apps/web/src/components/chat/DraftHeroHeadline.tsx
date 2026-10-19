import type { ScopedProjectRef } from "@spiritdevs/contracts";

import { WorkspaceProjectSelector } from "./WorkspaceProjectSelector";

interface DraftHeroHeadlineProps {
  readonly conversation?: boolean;
  readonly onSelectConversation?: () => void;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
  readonly onSelectProject: (projectRef: ScopedProjectRef) => void | Promise<void>;
}

export function DraftHeroHeadline({
  conversation = false,
  onSelectConversation,
  activeProjectRef,
  activeProjectTitle,
  onSelectProject,
}: DraftHeroHeadlineProps) {
  const hasResolvedProject = activeProjectTitle !== null;
  const projectSelector = (
    <WorkspaceProjectSelector
      conversation={conversation}
      onSelectConversation={onSelectConversation}
      activeProjectRef={activeProjectRef}
      activeProjectTitle={activeProjectTitle}
      ariaLabel={hasResolvedProject ? "Change project" : "Choose a project"}
      triggerClassName="pointer-events-auto inline-block max-w-64 truncate border-foreground/60 border-b border-dotted align-baseline text-foreground transition-colors hover:border-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      onSelectProject={onSelectProject}
    />
  );

  return (
    <h1 className="mx-auto w-full max-w-5xl text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
      {conversation ? (
        <>
          What would you like to discuss?{" "}
          <span className="mt-3 block text-base">{projectSelector}</span>
        </>
      ) : hasResolvedProject ? (
        <>What should we build in {projectSelector}?</>
      ) : (
        <>{projectSelector} to start</>
      )}
    </h1>
  );
}
