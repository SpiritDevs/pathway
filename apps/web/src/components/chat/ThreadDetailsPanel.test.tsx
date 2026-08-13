import type {
  EnvironmentId,
  ServerProvider,
  T3ProjectFileScript,
  ThreadId,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useT3ProjectFileScripts: vi.fn(),
  projectScriptsControl: vi.fn(),
  providerUsage: vi.fn(),
  providerUsageList: vi.fn(),
  runtimeControls: vi.fn(),
  threadIssuePanel: vi.fn(),
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
  EnvironmentRuntimeControls: (props: unknown) => {
    testState.runtimeControls(props);
    return null;
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
  ThreadAutomationsPanel: () => null,
}));
vi.mock("./ThreadIssuePanel", () => ({
  ThreadIssuePanel: (props: unknown) => {
    testState.threadIssuePanel(props);
    return null;
  },
}));
vi.mock("./ThreadRelationshipsControl", () => ({
  ThreadRelationshipsPanel: () => null,
}));

import { ThreadDetailsPanel, type ThreadDetailsPanelProps } from "./ThreadDetailsPanel";

describe("ThreadDetailsPanel", () => {
  beforeEach(() => {
    testState.useT3ProjectFileScripts.mockReset();
    testState.projectScriptsControl.mockReset();
    testState.providerUsage.mockReset();
    testState.providerUsageList.mockReset();
    testState.runtimeControls.mockReset();
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
    expect(testState.runtimeControls).toHaveBeenCalledWith({
      threadRef: { environmentId, threadId: props.threadId },
      enabled: true,
      displayMode: "panel",
    });
    expect(testState.threadIssuePanel).toHaveBeenCalledWith({
      threadId: props.threadId,
      enabled: true,
    });
  });

  it("restores provider usage for the active environment", () => {
    const environmentId = "environment:thread-details" as EnvironmentId;
    const threadId = "thread:thread-details" as ThreadId;
    const activeProvider = {
      driver: "codex",
      instanceId: "codex:default",
    } as ServerProvider;
    testState.useT3ProjectFileScripts.mockReturnValue([]);

    const props: ThreadDetailsPanelProps = {
      mode: "popover",
      environmentId,
      environmentConnection: null,
      threadId,
      activeProjectName: undefined,
      activeProjectScripts: undefined,
      activeProvider,
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
});
