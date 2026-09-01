import type { ScopedProjectRef } from "@spiritdevs/contracts";

import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { WorkspaceProjectSelector } from "./WorkspaceProjectSelector";

interface DraftHeroHeadlineProps {
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

export function DraftHeroHeadline({
  activeProjectRef,
  activeProjectTitle,
}: DraftHeroHeadlineProps) {
  const handleNewThread = useNewThreadHandler();
  const hasResolvedProject = activeProjectTitle !== null;
  const projectSelector = (
    <WorkspaceProjectSelector
      activeProjectRef={activeProjectRef}
      activeProjectTitle={activeProjectTitle}
      ariaLabel={hasResolvedProject ? "Change project" : "Choose a project"}
      triggerClassName="pointer-events-auto inline-block max-w-64 truncate border-foreground/60 border-b border-dotted align-baseline text-foreground transition-colors hover:border-foreground/80 focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      onSelectProject={(projectRef) => handleNewThread(projectRef, { replace: true })}
    />
  );

  return (
    <h1 className="mx-auto w-full max-w-5xl text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
      {hasResolvedProject ? (
        <>What should we build in {projectSelector}?</>
      ) : (
        <>{projectSelector} to start</>
      )}
    </h1>
  );
}
