import type {
  EnvironmentId,
  ServerProvider,
  T3ProjectFileScript,
  ThreadId,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  actionPaletteSections: [] as Array<{ id: string; visible: boolean }>,
  useT3ProjectFileScripts: vi.fn(),
  projectScriptsControl: vi.fn(),
  providerUsage: vi.fn(),
  providerUsageList: vi.fn(),
  developmentControls: vi.fn(),
  terminalControls: vi.fn(),
  threadIssuePanel: vi.fn(),
}));

vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: unknown) => unknown) =>
    selector({ actionPaletteSections: testState.actionPaletteSections }),
}));

vi.mock("../../hooks/useT3ProjectFileScripts", () => ({
  useT3ProjectFileScripts: (...args: ReadonlyArray<unknown>) =>
    testState.useT3ProjectFileScripts(...args),
}));
vi.mock("../BranchToolbar", () => ({
  BranchToolbar: () => null,
}));
vi.mock("../ProjectScriptsControl", () => ({
  default: (props: unknown) => {
    testState.projectScriptsControl(props);
    return null;
  },
}));
vi.mock("../EnvironmentRuntimeControls", () => ({
  DevelopmentEnvironmentControls: (props: unknown) => {
    testState.developmentControls(props);
    return <div>development-controls-sentinel</div>;
  },
  TerminalRuntimeControls: (props: unknown) => {
    testState.terminalControls(props);
    return <div>terminal-controls-sentinel</div>;
  },
}));
vi.mock("../usage/ProviderUsage", () => ({
  supportsProviderUsage: (provider: { driver?: string } | undefined) =>
    provider?.driver === "codex",
  EnvironmentProviderUsage: (props: unknown) => {
    testState.providerUsage(props);
    return null;
  },
  EnvironmentProviderUsageList: (props: unknown) => {
    testState.providerUsageList(props);
    return null;
  },
}));
vi.mock("./ThreadAutomationsPanel", () => ({
  ThreadAutomationsPanel: () => <div>automations-panel-sentinel</div>,
}));
vi.mock("./ThreadIssuePanel", () => ({
  ThreadIssuePanel: (props: unknown) => {
    testState.threadIssuePanel(props);
    return <div>issues-panel-sentinel</div>;
  },
}));
vi.mock("./ThreadRelationshipsControl", () => ({
  ThreadRelationshipsProvider: ({ children }: { children: unknown }) => children,
  ThreadChatsPanel: () => <div>chats-panel-sentinel</div>,
  ThreadLineagePanel: () => <div>lineage-panel-sentinel</div>,
}));

import { ThreadDetailsPanel, type ThreadDetailsPanelProps } from "./ThreadDetailsPanel";

describe("ThreadDetailsPanel", () => {
  beforeEach(() => {
    testState.actionPaletteSections = [];
    testState.useT3ProjectFileScripts.mockReset();
    testState.projectScriptsControl.mockReset();
    testState.providerUsage.mockReset();
    testState.providerUsageList.mockReset();
    testState.developmentControls.mockReset();
    testState.terminalControls.mockReset();
    testState.threadIssuePanel.mockReset();
  });

  it("passes checked-in t3.json scripts to the project scripts control", () => {
    const environmentId = "environment:thread-details" as EnvironmentId;
    const gitCwd = "/tmp/thread-details-project";
    const fileScripts = [
      {
        name: "Check project",
        command: "vp check",
        icon: "test",
      },
    ] satisfies ReadonlyArray<T3ProjectFileScript>;
    testState.useT3ProjectFileScripts.mockReturnValue(fileScripts);

    const props: ThreadDetailsPanelProps = {
      mode: "popover",
      environmentId,
      environmentConnection: null,
      threadId: "thread:thread-details" as ThreadId,
      activeProjectName: undefined,
      activeProjectScripts: [],
      activeProvider: null,
      resourcesEnabled: true,
      preferredScriptId: null,
      keybindings: [],
      availableEditors: [],
      showOpenInPicker: false,
      gitCwd,
      isGitRepo: false,
      envLocked: false,
      availableEnvironments: [],
      onEnvironmentChange: vi.fn(),
      onEnvModeChange: vi.fn(),
      startFromOrigin: false,
      onStartFromOriginChange: vi.fn(),
      onComposerFocusRequest: vi.fn(),
      onReconnectEnvironment: vi.fn(),
      onOpenConnectionSettings: vi.fn(),
      versionMismatch: null,
      onDismissVersionMismatch: vi.fn(),
      onRunProjectScript: vi.fn(),
      onAddProjectScript: vi.fn() as ThreadDetailsPanelProps["onAddProjectScript"],
      onUpdateProjectScript: vi.fn() as ThreadDetailsPanelProps["onUpdateProjectScript"],
      onDeleteProjectScript: vi.fn() as ThreadDetailsPanelProps["onDeleteProjectScript"],
    };

    const html = renderToStaticMarkup(<ThreadDetailsPanel {...props} />);

    expect(html).toContain("Actions");
    expect(testState.useT3ProjectFileScripts).toHaveBeenCalledWith(environmentId, gitCwd);
    expect(testState.projectScriptsControl).toHaveBeenCalledWith(
      expect.objectContaining({
        displayMode: "panel",
        scripts: [],
        fileScripts,
      }),
    );
    expect(testState.developmentControls).toHaveBeenCalledWith({
      threadRef: { environmentId, threadId: props.threadId },
      enabled: true,
      displayMode: "panel",
    });
    expect(testState.terminalControls).toHaveBeenCalledWith({
      threadRef: { environmentId, threadId: props.threadId },
      displayMode: "panel",
    });
    expect(testState.threadIssuePanel).toHaveBeenCalledWith({
      threadId: props.threadId,
      enabled: true,
    });
  });

  it("places the issues section between the runtime controls and version control", () => {
    const environmentId = "environment:thread-details" as EnvironmentId;
    testState.useT3ProjectFileScripts.mockReturnValue([]);

    const props: ThreadDetailsPanelProps = {
      mode: "popover",
      environmentId,
      environmentConnection: null,
      threadId: "thread:thread-details" as ThreadId,
      activeProjectName: undefined,
      activeProjectScripts: undefined,
      activeProvider: null,
      resourcesEnabled: true,
      preferredScriptId: null,
      keybindings: [],
      availableEditors: [],
      showOpenInPicker: false,
      gitCwd: "/tmp/thread-details-project",
      isGitRepo: true,
      envLocked: false,
      availableEnvironments: [],
      onEnvironmentChange: vi.fn(),
      onEnvModeChange: vi.fn(),
      startFromOrigin: false,
      onStartFromOriginChange: vi.fn(),
      onComposerFocusRequest: vi.fn(),
      onReconnectEnvironment: vi.fn(),
      onOpenConnectionSettings: vi.fn(),
      versionMismatch: null,
      onDismissVersionMismatch: vi.fn(),
      onRunProjectScript: vi.fn(),
      onAddProjectScript: vi.fn() as ThreadDetailsPanelProps["onAddProjectScript"],
      onUpdateProjectScript: vi.fn() as ThreadDetailsPanelProps["onUpdateProjectScript"],
      onDeleteProjectScript: vi.fn() as ThreadDetailsPanelProps["onDeleteProjectScript"],
    };

    const html = renderToStaticMarkup(<ThreadDetailsPanel {...props} />);
    const runtimeIndex = html.indexOf("terminal-controls-sentinel");
    const issuesIndex = html.indexOf("issues-panel-sentinel");
    const versionControlIndex = html.indexOf("Version Control");

    expect(runtimeIndex).toBeGreaterThan(-1);
    expect(versionControlIndex).toBeGreaterThan(-1);
    expect(issuesIndex).toBeGreaterThan(runtimeIndex);
    expect(issuesIndex).toBeLessThan(versionControlIndex);
  });

  it("restores provider usage for the active environment", () => {
    const environmentId = "environment:thread-details" as EnvironmentId;
    const threadId = "thread:thread-details" as ThreadId;
    const activeProvider = {
      driver: "codex",
      instanceId: "codex:default",
    } as ServerProvider;
    const activeProviderEntry = {
      displayName: "Work Codex",
    } as NonNullable<ThreadDetailsPanelProps["activeProviderEntry"]>;
    testState.useT3ProjectFileScripts.mockReturnValue([]);

    const props: ThreadDetailsPanelProps = {
      mode: "popover",
      environmentId,
      environmentConnection: null,
      threadId,
      activeProjectName: undefined,
      activeProjectScripts: undefined,
      activeProvider,
      activeProviderEntry,
      activeProviderIconBadge: true,
      resourcesEnabled: true,
      preferredScriptId: null,
      keybindings: [],
      availableEditors: [],
      showOpenInPicker: false,
      gitCwd: null,
      isGitRepo: false,
      envLocked: false,
      availableEnvironments: [],
      onEnvironmentChange: vi.fn(),
      onEnvModeChange: vi.fn(),
      startFromOrigin: false,
      onStartFromOriginChange: vi.fn(),
      onComposerFocusRequest: vi.fn(),
      onReconnectEnvironment: vi.fn(),
      onOpenConnectionSettings: vi.fn(),
      versionMismatch: null,
      onDismissVersionMismatch: vi.fn(),
      onRunProjectScript: vi.fn(),
      onAddProjectScript: vi.fn() as ThreadDetailsPanelProps["onAddProjectScript"],
      onUpdateProjectScript: vi.fn() as ThreadDetailsPanelProps["onUpdateProjectScript"],
      onDeleteProjectScript: vi.fn() as ThreadDetailsPanelProps["onDeleteProjectScript"],
    };

    renderToStaticMarkup(<ThreadDetailsPanel {...props} />);

    expect(testState.providerUsage).toHaveBeenCalledWith({
      environmentId,
      provider: activeProvider,
      enabled: true,
      displayMode: "panel",
      iconDisplayName: "Work Codex",
      showIconBadge: true,
    });
    expect(testState.providerUsageList).not.toHaveBeenCalled();
  });

  it("shows every supported provider on a new thread without depending on the picker selection", () => {
    const environmentId = "environment:new-thread" as EnvironmentId;
    const threadId = "thread:new-thread" as ThreadId;
    testState.useT3ProjectFileScripts.mockReturnValue([]);

    const props: ThreadDetailsPanelProps = {
      mode: "popover",
      environmentId,
      environmentConnection: null,
      threadId,
      draftId: "draft:new-thread" as NonNullable<ThreadDetailsPanelProps["draftId"]>,
      activeProjectName: undefined,
      activeProjectScripts: undefined,
      activeProvider: {
        driver: "codex",
        instanceId: "codex:default",
      } as ServerProvider,
      resourcesEnabled: true,
      preferredScriptId: null,
      keybindings: [],
      availableEditors: [],
      showOpenInPicker: false,
      gitCwd: null,
      isGitRepo: false,
      envLocked: false,
      availableEnvironments: [],
      onEnvironmentChange: vi.fn(),
      onEnvModeChange: vi.fn(),
      startFromOrigin: false,
      onStartFromOriginChange: vi.fn(),
      onComposerFocusRequest: vi.fn(),
      onReconnectEnvironment: vi.fn(),
      onOpenConnectionSettings: vi.fn(),
      versionMismatch: null,
      onDismissVersionMismatch: vi.fn(),
      onRunProjectScript: vi.fn(),
      onAddProjectScript: vi.fn() as ThreadDetailsPanelProps["onAddProjectScript"],
      onUpdateProjectScript: vi.fn() as ThreadDetailsPanelProps["onUpdateProjectScript"],
      onDeleteProjectScript: vi.fn() as ThreadDetailsPanelProps["onDeleteProjectScript"],
    };

    renderToStaticMarkup(<ThreadDetailsPanel {...props} />);

    expect(testState.providerUsageList).toHaveBeenCalledWith({
      environmentId,
      enabled: true,
    });
    expect(testState.providerUsage).not.toHaveBeenCalled();
  });

  it.each(["inline", "popover"] as const)(
    "applies the same visibility and ordering in %s mode",
    (mode) => {
      const environmentId = "environment:configured-palette" as EnvironmentId;
      testState.useT3ProjectFileScripts.mockReturnValue([]);
      testState.actionPaletteSections = [
        { id: "issues", visible: true },
        { id: "workspace", visible: true },
        { id: "actions", visible: true },
        { id: "usage", visible: true },
        { id: "development-environments", visible: false },
        { id: "terminals", visible: true },
        { id: "version-control", visible: true },
        { id: "automations", visible: true },
        { id: "chats", visible: true },
        { id: "lineage", visible: true },
      ];

      const props: ThreadDetailsPanelProps = {
        mode,
        environmentId,
        environmentConnection: null,
        threadId: "thread:configured-palette" as ThreadId,
        activeProjectName: undefined,
        activeProjectScripts: undefined,
        activeProvider: null,
        resourcesEnabled: true,
        preferredScriptId: null,
        keybindings: [],
        availableEditors: [],
        showOpenInPicker: false,
        gitCwd: "/tmp/configured-palette",
        isGitRepo: true,
        envLocked: false,
        availableEnvironments: [],
        onEnvironmentChange: vi.fn(),
        onEnvModeChange: vi.fn(),
        startFromOrigin: false,
        onStartFromOriginChange: vi.fn(),
        onComposerFocusRequest: vi.fn(),
        onReconnectEnvironment: vi.fn(),
        onOpenConnectionSettings: vi.fn(),
        versionMismatch: null,
        onDismissVersionMismatch: vi.fn(),
        onRunProjectScript: vi.fn(),
        onAddProjectScript: vi.fn() as ThreadDetailsPanelProps["onAddProjectScript"],
        onUpdateProjectScript: vi.fn() as ThreadDetailsPanelProps["onUpdateProjectScript"],
        onDeleteProjectScript: vi.fn() as ThreadDetailsPanelProps["onDeleteProjectScript"],
      };

      const html = renderToStaticMarkup(<ThreadDetailsPanel {...props} />);

      expect(html.indexOf("issues-panel-sentinel")).toBeLessThan(html.indexOf("Workspace"));
      expect(html).not.toContain("development-controls-sentinel");
      expect(html).toContain("terminal-controls-sentinel");
      expect(testState.developmentControls).not.toHaveBeenCalled();
    },
  );
});
