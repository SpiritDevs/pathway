import type {
  EditorId,
  EnvironmentId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ServerProvider,
  ThreadId,
} from "@spiritdevs/contracts";
import type { EnvironmentConnectionPresentation } from "@spiritdevs/client-runtime/connection";
import { AlertTriangleIcon, XIcon } from "lucide-react";

import type { DraftId } from "../../composerDraftStore";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { useT3ProjectFileScripts } from "../../hooks/useT3ProjectFileScripts";
import type { EnvMode, EnvironmentOption } from "../BranchToolbar.logic";
import { BranchToolbar } from "../BranchToolbar";
import { BranchToolbarEnvironmentSelector } from "../BranchToolbarEnvironmentSelector";
import {
  DevelopmentEnvironmentControls,
  TerminalRuntimeControls,
} from "../EnvironmentRuntimeControls";
import GitActionsControl from "../GitActionsControl";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";
import { OpenInPicker } from "./OpenInPicker";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
import { ThreadIssuePanel } from "./ThreadIssuePanel";
import {
  ThreadChatsPanel,
  ThreadLineagePanel,
  ThreadRelationshipsProvider,
} from "./ThreadRelationshipsControl";
import {
  EnvironmentProviderUsage,
  EnvironmentProviderUsageList,
  supportsProviderUsage,
} from "../usage/ProviderUsage";
import { useClientSettings } from "../../hooks/useSettings";
import { resolveActionPaletteSections, type ActionPaletteSectionId } from "./actionPaletteSections";

interface VersionMismatchIssue {
  readonly clientVersion: string;
  readonly serverVersion: string;
  readonly serverLabel: string;
}

export interface ThreadDetailsPanelProps {
  mode: "inline" | "popover";
  onClose?: () => void;
  environmentId: EnvironmentId;
  environmentConnection: EnvironmentConnectionPresentation | null;
  threadId: ThreadId;
  draftId?: DraftId;
  activeProjectName: string | undefined;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  activeProvider: ServerProvider | null;
  activeProviderEntry?: ProviderInstanceEntry | null;
  activeProviderIconBadge?: boolean;
  resourcesEnabled: boolean;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  showOpenInPicker: boolean;
  gitCwd: string | null;
  isGitRepo: boolean;
  envLocked: boolean;
  availableEnvironments: readonly EnvironmentOption[];
  onEnvironmentChange: (environmentId: EnvironmentId) => void;
  onEnvModeChange: (mode: EnvMode) => void;
  effectiveEnvModeOverride?: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest: () => void;
  onOpenChanges?: () => void;
  onHandoff?: () => void;
  onRecoverPushFailure?: (prompt: string) => Promise<boolean>;
  onReconnectEnvironment: () => void;
  onOpenConnectionSettings: () => void;
  versionMismatch: VersionMismatchIssue | null;
  onDismissVersionMismatch: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

function ThreadDetailsActionsSection({
  activeProjectScripts,
  gitCwd,
  keybindings,
  preferredScriptId,
  environmentId,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
}: Pick<
  ThreadDetailsPanelProps,
  | "activeProjectScripts"
  | "gitCwd"
  | "keybindings"
  | "preferredScriptId"
  | "environmentId"
  | "onRunProjectScript"
  | "onAddProjectScript"
  | "onUpdateProjectScript"
  | "onDeleteProjectScript"
>) {
  const fileScripts = useT3ProjectFileScripts(environmentId, activeProjectScripts ? gitCwd : null);
  if (!activeProjectScripts) return null;

  return (
    <section aria-labelledby="thread-details-actions-heading" className="border-t border-border/65">
      <div className="px-3.5 pb-1 pt-3">
        <h3
          id="thread-details-actions-heading"
          className="text-[11px] font-medium text-muted-foreground"
        >
          Actions
        </h3>
      </div>
      <div className="flex flex-col px-2 pb-2.5">
        <ProjectScriptsControl
          displayMode="panel"
          scripts={activeProjectScripts}
          fileScripts={fileScripts}
          keybindings={keybindings}
          preferredScriptId={preferredScriptId}
          onRunScript={onRunProjectScript}
          onAddScript={onAddProjectScript}
          onUpdateScript={onUpdateProjectScript}
          onDeleteScript={onDeleteProjectScript}
        />
      </div>
    </section>
  );
}

export function ThreadDetailsPanel(props: ThreadDetailsPanelProps) {
  const actionPalettePreferences = useClientSettings((settings) => settings.actionPaletteSections);
  const visibleSections = resolveActionPaletteSections(actionPalettePreferences).filter(
    (section) => section.visible,
  );
  const activeProvider = props.activeProvider ?? undefined;
  const usageProvider = supportsProviderUsage(activeProvider) ? activeProvider : null;
  const connectionIssue =
    props.environmentConnection !== null &&
    props.environmentConnection.phase !== "connected" &&
    props.environmentConnection.phase !== "available";
  const isReconnecting =
    props.environmentConnection?.phase === "connecting" ||
    props.environmentConnection?.phase === "reconnecting";
  const branchToolbarProps = {
    showGitControls: props.isGitRepo,
    environmentId: props.environmentId,
    threadId: props.threadId,
    ...(props.draftId ? { draftId: props.draftId } : {}),
    onEnvModeChange: props.onEnvModeChange,
    startFromOrigin: props.startFromOrigin,
    onStartFromOriginChange: props.onStartFromOriginChange,
    ...(props.effectiveEnvModeOverride
      ? { effectiveEnvModeOverride: props.effectiveEnvModeOverride }
      : {}),
    ...(props.activeThreadBranchOverride !== undefined
      ? { activeThreadBranchOverride: props.activeThreadBranchOverride }
      : {}),
    ...(props.onActiveThreadBranchOverrideChange
      ? { onActiveThreadBranchOverrideChange: props.onActiveThreadBranchOverrideChange }
      : {}),
    envLocked: props.envLocked,
    onComposerFocusRequest: props.onComposerFocusRequest,
    ...(props.onCheckoutPullRequestRequest
      ? { onCheckoutPullRequestRequest: props.onCheckoutPullRequestRequest }
      : {}),
  };

  const renderSection = (sectionId: ActionPaletteSectionId) => {
    switch (sectionId) {
      case "workspace":
        return (
          <section key={sectionId} aria-labelledby="thread-details-workspace-heading">
            <div className="flex min-h-10 items-center justify-between gap-3 px-3.5 pb-1 pt-3">
              <h3
                id="thread-details-workspace-heading"
                className="text-[11px] font-medium text-muted-foreground"
              >
                Workspace
              </h3>
            </div>

            {connectionIssue ? (
              <div className="mx-3 mb-2 rounded-xl border border-warning/30 bg-warning/6 p-3">
                <div className="flex gap-2">
                  <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium">Environment unavailable</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                      {props.environmentConnection?.error ??
                        "Reconnect this environment before sending messages or running actions."}
                    </p>
                    <div className="mt-2 flex items-center gap-1.5">
                      <Button
                        size="xs"
                        disabled={isReconnecting}
                        onClick={props.onReconnectEnvironment}
                      >
                        {isReconnecting ? "Reconnecting..." : "Reconnect"}
                      </Button>
                      <Button size="xs" variant="ghost" onClick={props.onOpenConnectionSettings}>
                        Connections
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {props.versionMismatch ? (
              <div className="mx-3 mb-2 flex gap-2 rounded-xl border border-warning/30 bg-warning/6 p-3">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">Client and server versions differ</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    Client {props.versionMismatch.clientVersion} ·{" "}
                    {props.versionMismatch.serverLabel} {props.versionMismatch.serverVersion}
                  </p>
                </div>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Dismiss version mismatch warning"
                  onClick={props.onDismissVersionMismatch}
                >
                  <XIcon className="size-3.5" />
                </Button>
              </div>
            ) : null}

            <div className="flex flex-col px-2 pb-2.5">
              {props.availableEnvironments.length > 1 ? (
                <BranchToolbarEnvironmentSelector
                  displayMode="panel"
                  envLocked={props.envLocked}
                  environmentId={props.environmentId}
                  availableEnvironments={props.availableEnvironments}
                  onEnvironmentChange={props.onEnvironmentChange}
                />
              ) : null}
              <BranchToolbar layout="panel" panelSection="workspace" {...branchToolbarProps} />
              {props.showOpenInPicker ? (
                <OpenInPicker
                  environmentId={props.environmentId}
                  keybindings={props.keybindings}
                  availableEditors={props.availableEditors}
                  openInCwd={props.gitCwd}
                  displayMode="panel"
                />
              ) : null}
            </div>
          </section>
        );
      case "actions":
        return (
          <ThreadDetailsActionsSection
            key={sectionId}
            activeProjectScripts={props.activeProjectScripts}
            gitCwd={props.gitCwd}
            keybindings={props.keybindings}
            preferredScriptId={props.preferredScriptId}
            environmentId={props.environmentId}
            onRunProjectScript={props.onRunProjectScript}
            onAddProjectScript={props.onAddProjectScript}
            onUpdateProjectScript={props.onUpdateProjectScript}
            onDeleteProjectScript={props.onDeleteProjectScript}
          />
        );
      case "usage":
        return props.draftId ? (
          <EnvironmentProviderUsageList
            key={sectionId}
            environmentId={props.environmentId}
            enabled={props.resourcesEnabled}
          />
        ) : usageProvider ? (
          <EnvironmentProviderUsage
            key={sectionId}
            environmentId={props.environmentId}
            provider={usageProvider}
            enabled={props.resourcesEnabled}
            displayMode="panel"
            {...(props.activeProviderEntry
              ? { iconDisplayName: props.activeProviderEntry.displayName }
              : {})}
            {...(props.activeProviderIconBadge === undefined
              ? {}
              : { showIconBadge: props.activeProviderIconBadge })}
          />
        ) : null;
      case "development-environments":
        return (
          <DevelopmentEnvironmentControls
            key={sectionId}
            threadRef={{ environmentId: props.environmentId, threadId: props.threadId }}
            enabled={props.resourcesEnabled}
            displayMode="panel"
          />
        );
      case "terminals":
        return (
          <TerminalRuntimeControls
            key={sectionId}
            threadRef={{ environmentId: props.environmentId, threadId: props.threadId }}
            displayMode="panel"
          />
        );
      case "issues":
        return props.draftId ? null : (
          <ThreadIssuePanel
            key={sectionId}
            threadId={props.threadId}
            enabled={props.resourcesEnabled}
          />
        );
      case "version-control":
        return props.gitCwd ? (
          <section
            key={sectionId}
            aria-labelledby="thread-details-version-control-heading"
            className="border-t border-border/65"
          >
            <div className="px-3.5 pb-1 pt-3">
              <h3
                id="thread-details-version-control-heading"
                className="text-[11px] font-medium text-muted-foreground"
              >
                Version Control
              </h3>
            </div>
            <div className="flex flex-col px-2 pb-2.5">
              {props.isGitRepo ? (
                <BranchToolbar layout="panel" panelSection="branch" {...branchToolbarProps} />
              ) : null}
              {props.activeProjectName ? (
                <GitActionsControl
                  displayMode="panel"
                  gitCwd={props.gitCwd}
                  activeThreadRef={{ environmentId: props.environmentId, threadId: props.threadId }}
                  {...(props.draftId ? { draftId: props.draftId } : {})}
                  {...(props.onOpenChanges ? { onOpenChanges: props.onOpenChanges } : {})}
                  {...(props.onHandoff ? { onHandoff: props.onHandoff } : {})}
                  {...(props.onRecoverPushFailure
                    ? { onRecoverPushFailure: props.onRecoverPushFailure }
                    : {})}
                />
              ) : null}
            </div>
          </section>
        ) : null;
      case "automations":
        return props.draftId ? null : (
          <ThreadAutomationsPanel
            key={sectionId}
            environmentId={props.environmentId}
            threadId={props.threadId}
          />
        );
      case "chats":
        return props.draftId ? null : <ThreadChatsPanel key={sectionId} />;
      case "lineage":
        return props.draftId ? null : <ThreadLineagePanel key={sectionId} />;
    }
  };

  const sectionContent = visibleSections.map((section) => renderSection(section.id));
  const relationshipSectionsVisible =
    !props.draftId &&
    visibleSections.some((section) => section.id === "chats" || section.id === "lineage");

  const card = (
    <div
      className={cn(
        // A single-track grid, because a grid area is a definite containing block: the card's own
        // height is "content, clamped by max-height", which percentages treat as indefinite — as
        // a plain block (or even a flex column) every `h-full`/`max-h-full` down the chain
        // resolved to nothing, the scroll area's viewport stayed at its content height, and the
        // card's overflow-hidden clipped the content instead of scrolling it. `minmax(0,1fr)`
        // still shrink-wraps short content while letting the clamp bite on tall content.
        "dropdown-glass isolate contain-paint grid max-h-full grid-rows-[minmax(0,1fr)] overflow-hidden rounded-[20px]",
        // The popup's real ceiling is what base-ui measured for it — the anchor's clipping
        // ancestors, which is how an open terminal drawer shrinks it — less the popover
        // viewport's own p-2. The dvh term is the fallback's fallback, from before.
        props.mode === "popover" &&
          "max-h-[min(calc(100dvh-6.5rem),calc(var(--available-height,100dvh)-1rem))]",
      )}
      data-thread-details-card
    >
      <ScrollArea scrollFade className="min-h-0">
        {relationshipSectionsVisible ? (
          <ThreadRelationshipsProvider
            environmentId={props.environmentId}
            threadId={props.threadId}
          >
            {sectionContent}
          </ThreadRelationshipsProvider>
        ) : (
          sectionContent
        )}
      </ScrollArea>
    </div>
  );

  if (props.mode === "popover") {
    return <div data-thread-details-panel="popover">{card}</div>;
  }

  return (
    <aside
      aria-label="Thread details"
      className="absolute inset-y-0 right-[var(--app-scrollbar-width)] z-20 w-[var(--thread-details-panel-width)] p-3"
      data-thread-details-panel="inline"
    >
      {card}
    </aside>
  );
}
