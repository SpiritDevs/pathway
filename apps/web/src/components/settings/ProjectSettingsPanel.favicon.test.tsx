import type { ReactElement } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ProjectEntry,
} from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  projectUpdate: Symbol("projectUpdate"),
  projectDelete: Symbol("projectDelete"),
  upsertKeybinding: Symbol("upsertKeybinding"),
  removeKeybinding: Symbol("removeKeybinding"),
  providers: Symbol("providers"),
  keybindings: Symbol("keybindings"),
}));

const commands = vi.hoisted(() => ({
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  upsertKeybinding: vi.fn(),
  removeKeybinding: vi.fn(),
}));

const pickerState = vi.hoisted(() => ({
  entries: [
    {
      kind: "file",
      path: "brand assets/nested/project icon.svg",
    },
  ] as ProjectEntry[],
}));

const toastState = vi.hoisted(() => ({ add: vi.fn() }));
const threadState = vi.hoisted(() => ({
  threads: [] as Array<{ environmentId: EnvironmentId; projectId: ProjectId }>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: symbol) => (atom === atoms.providers ? [] : null),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: unknown }) => children,
  useCanGoBack: () => false,
  useNavigate: () => vi.fn(),
}));

vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: () => ({
    sidebarProjectGroupingMode: "repository",
    sidebarProjectGroupingOverrides: {},
  }),
  usePrimarySettings: () => DEFAULT_UNIFIED_SETTINGS,
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn() }),
}));
vi.mock("../../hooks/usePathwayProjectFileScripts", () => ({
  usePathwayProjectFileState: () => ({ file: null, scripts: [] }),
}));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [],
  useThreadShells: () => threadState.threads,
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [], presentationById: new Map() }),
  usePrimaryEnvironmentId: () => EnvironmentId.make("local"),
}));
vi.mock("../../state/projects", () => ({
  projectEnvironment: {
    update: atoms.projectUpdate,
    delete: atoms.projectDelete,
  },
}));
vi.mock("../../state/server", () => ({
  primaryServerKeybindingsAtom: atoms.keybindings,
  primaryServerProvidersAtom: atoms.providers,
  serverEnvironment: {
    configValueAtom: () => Symbol("config"),
    upsertKeybinding: atoms.upsertKeybinding,
    removeKeybinding: atoms.removeKeybinding,
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) => {
    if (atom === atoms.projectUpdate) return commands.updateProject;
    if (atom === atoms.projectDelete) return commands.deleteProject;
    if (atom === atoms.upsertKeybinding) return commands.upsertKeybinding;
    return commands.removeKeybinding;
  },
}));
vi.mock("../files/projectFilesQueryState", () => ({
  useProjectFilePickerQuery: () => ({
    entries: pickerState.entries,
    error: null,
    isPending: false,
    matchedQuery: "",
  }),
}));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (input: unknown) => input,
  toastManager: toastState,
}));

import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import type { Project } from "../../types";
import { ProjectFavicon } from "../ProjectFavicon";
import { MenuItem } from "../ui/menu";
import { ProjectFaviconPickerDialog } from "./ProjectFaviconPickerDialog";
import { ProjectDetail } from "./ProjectSettingsPanel";

const localEnvironmentId = EnvironmentId.make("local");
const remoteEnvironmentId = EnvironmentId.make("remote");
const selectedPath = "brand assets/nested/project icon.svg";

function makeProject(
  environmentId: EnvironmentId,
  id: string,
  workspaceRoot: string,
  faviconPath: string | null,
): Project {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: "Pathway",
    workspaceRoot,
    repositoryIdentity: {
      canonicalKey: "github.com/spiritdevs/pathway",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/spiritdevs/pathway.git",
      },
      provider: "github",
      owner: "spiritdevs",
      name: "pathway",
      displayName: "Pathway",
    },
    faviconPath,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  };
}

function makeGroup(faviconPath: string | null, includeRemote = true) {
  return buildSidebarProjectSnapshots({
    projects: [
      makeProject(localEnvironmentId, "project-local", "/workspace/pathway", faviconPath),
      ...(includeRemote
        ? [makeProject(remoteEnvironmentId, "project-remote", "/remote/pathway", faviconPath)]
        : []),
    ],
    settings: {
      sidebarProjectGroupingMode: "repository",
      sidebarProjectGroupingOverrides: {},
    },
    primaryEnvironmentId: localEnvironmentId,
    resolveEnvironmentLabel: (environmentId) =>
      environmentId === localEnvironmentId ? "This machine" : "Remote Mac",
  })[0]!;
}

function renderDetail(
  faviconPath: string | null,
  includeRemote = true,
): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return ProjectDetail({
    group: makeGroup(faviconPath, includeRemote),
  }) as ReactElement<Record<string, unknown>>;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Project settings favicon selection", () => {
  beforeEach(() => {
    hooks.reset();
    toastState.add.mockReset();
    commands.updateProject.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
    commands.deleteProject.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
    commands.upsertKeybinding.mockReset().mockResolvedValue({
      _tag: "Success",
      value: undefined,
    });
    commands.removeKeybinding.mockReset().mockResolvedValue({
      _tag: "Success",
      value: undefined,
    });
    threadState.threads = [
      { environmentId: localEnvironmentId, projectId: ProjectId.make("project-local") },
      { environmentId: localEnvironmentId, projectId: ProjectId.make("project-local") },
    ];
  });

  it("fans the selected relative path out to every member and renders projected state", async () => {
    const initial = renderDetail(null);
    const chooseButton = visitElements(
      initial,
      (element) => element.props["aria-label"] === "Choose a project icon file",
    );
    expect(chooseButton).not.toBeNull();
    (chooseButton?.props.onClick as (() => void) | undefined)?.();

    const picker = visitElements(
      renderDetail(null),
      (element) => element.type === ProjectFaviconPickerDialog && element.props.open === true,
    );
    expect(picker).not.toBeNull();
    if (!picker) throw new Error("Expected the project favicon picker to open.");
    await (picker.props.onSelect as (path: string) => Promise<void>)(selectedPath);

    expect(commands.updateProject.mock.calls).toEqual([
      [
        {
          environmentId: localEnvironmentId,
          input: { projectId: ProjectId.make("project-local"), faviconPath: selectedPath },
        },
      ],
      [
        {
          environmentId: remoteEnvironmentId,
          input: { projectId: ProjectId.make("project-remote"), faviconPath: selectedPath },
        },
      ],
    ]);

    const projected = renderDetail(selectedPath);
    const projectIconRow = visitElements(
      projected,
      (element) => element.props.title === "Project icon",
    );
    expect(projectIconRow?.props.description).toBe(selectedPath);
    expect(
      visitElements(
        projected,
        (element) => element.type === ProjectFavicon && element.props.faviconPath === selectedPath,
      ),
    ).not.toBeNull();
  });

  it("keeps the prior projected icon and reports a failed grouped save", async () => {
    commands.updateProject.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("Unsupported or missing workspace image")),
    });
    const priorPath = "branding/previous.png";
    const detail = renderDetail(priorPath);
    const picker = visitElements(detail, (element) => element.type === ProjectFaviconPickerDialog);
    if (!picker) throw new Error("Expected the project favicon picker to render.");
    await (picker.props.onSelect as (path: string) => Promise<void>)(selectedPath);

    expect(commands.updateProject).toHaveBeenCalledTimes(1);
    expect(toastState.add).toHaveBeenCalledOnce();
    expect(toastState.add.mock.calls[0]?.[0]).toMatchObject({
      type: "error",
      title: "Failed to update project icon on This machine",
    });
    expect(
      visitElements(
        renderDetail(priorPath),
        (element) => element.type === ProjectFavicon && element.props.faviconPath === priorPath,
      ),
    ).not.toBeNull();
  });

  it("shows thread counts on connections and protects the final connection", () => {
    const grouped = renderDetail(null);
    expect(
      visitElements(grouped, (element) => element.props.children === "2 threads"),
    ).not.toBeNull();
    const removable = visitElements(
      grouped,
      (element) =>
        element.type === MenuItem &&
        Array.isArray(element.props.children) &&
        element.props.children.includes("Remove connection"),
    );
    expect(removable?.props.disabled).toBe(false);

    hooks.reset();
    const onlyConnection = renderDetail(null, false);
    const protectedRemoval = visitElements(
      onlyConnection,
      (element) =>
        element.type === MenuItem &&
        Array.isArray(element.props.children) &&
        element.props.children.includes("Remove connection"),
    );
    expect(protectedRemoval?.props.disabled).toBe(true);
  });

  it("uses one retained picker action for pointer and Enter activation", async () => {
    hooks.reset();
    const onOpenChange = vi.fn();
    const onSelect = vi.fn().mockResolvedValue(undefined);
    hooks.beginRender();
    const dialog = ProjectFaviconPickerDialog({
      cwd: "/workspace/pathway",
      environmentId: localEnvironmentId,
      onOpenChange,
      onSelect,
      open: true,
      projectName: "Pathway",
    }) as ReactElement<Record<string, unknown>>;
    const results = visitElements(
      dialog,
      (element) => typeof element.props.onExecuteItem === "function",
    );
    if (!results) throw new Error("Expected picker results to render.");
    const item = (results.props.groups as Array<{ items: unknown[] }>)[0]?.items[0];
    (results.props.onExecuteItem as (selected: unknown) => void)(item);
    await flushPromises();

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSelect).toHaveBeenCalledWith(selectedPath);
  });
});
