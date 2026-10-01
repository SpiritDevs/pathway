import { EnvironmentId, ProjectId, ThreadId, type DeviceSummary } from "@spiritdevs/contracts";
import type {
  SimBuildDiscovery,
  SimBuildJob,
  SimBuildLogChunk,
} from "@spiritdevs/contracts/simBuild";
import type { SimBuildView } from "@spiritdevs/client-runtime/state/simBuild";
import { act, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type Result = { _tag: "Success"; value: unknown } | { _tag: "Failure"; cause: unknown };
const commands = vi.hoisted(() => ({
  discover: vi.fn<(target: unknown) => Promise<Result>>(),
  start: vi.fn<(target: unknown) => Promise<Result>>(),
  list: vi.fn<(target: unknown) => Promise<Result>>(),
  cancel: vi.fn<(target: unknown) => Promise<Result>>(),
  open: vi.fn<(target: string) => Promise<Result>>(),
  view: { current: null as SimBuildView | null },
  subscribed: vi.fn<(target: unknown) => void>(),
}));
vi.mock("~/state/simBuild", () => ({
  simBuildEnvironment: {
    discover: "discover",
    start: "start",
    list: "list",
    cancel: "cancel",
    view: (target: unknown) => {
      commands.subscribed(target);
      return target;
    },
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: "discover" | "start" | "list" | "cancel") => commands[command],
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({ data: atom ? commands.view.current : null }),
}));
vi.mock("~/state/server", () => ({ serverEnvironment: { configValueAtom: () => "config" } }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ availableEditors: ["vscode"] }) }));
vi.mock("~/editorPreferences", () => ({ useOpenInPreferredEditor: () => commands.open }));
vi.mock("@tanstack/react-router", () => ({
  Link: (props: { to: string; children?: ReactNode }) => <a href={props.to}>{props.children}</a>,
}));
vi.mock("@spiritdevs/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (result: { cause: unknown }) => result.cause,
}));
vi.mock("../ui/select", () => ({
  Select: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  SelectTrigger: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  SelectValue: (props: { children?: ReactNode }) => <span>{props.children}</span>,
  SelectPopup: () => null,
  SelectItem: () => null,
}));
vi.mock("../ui/toggle-group", () => ({
  ToggleGroup: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  Toggle: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));

const { SimBuildBar } = await import("./SimBuildBar");

const environmentId = EnvironmentId.make("environment");
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("thread");
const context = { environmentId, projectId, threadId };
const device: DeviceSummary = {
  hostId: "local",
  id: "sim-1",
  name: "iPhone 17",
  platform: "ios",
  version: "iOS 26",
  booted: true,
  physical: false,
};
const discovery: SimBuildDiscovery = {
  ...context,
  workspaceRoot: "/repo",
  framework: "xcode",
  developerDir: "/Applications/Xcode.app/Contents/Developer",
  containers: [
    {
      path: "App.xcodeproj",
      kind: "project",
      schemes: ["App"],
      targets: ["App"],
      configurations: ["Debug", "Release"],
    },
  ],
  notices: [],
};
const job = (patch: Partial<SimBuildJob> = {}): SimBuildJob => ({
  ...context,
  hostId: "local",
  deviceId: "sim-1",
  containerPath: "App.xcodeproj",
  scheme: "App",
  action: "run",
  requestId: "request-1",
  id: "job-1",
  workspaceRoot: "/repo",
  developerDir: discovery.developerDir,
  phase: "building",
  terminal: false,
  artifact: null,
  failure: null,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});
const chunk = (sequence: number, text: string, patch: Partial<SimBuildLogChunk> = {}) => ({
  sequence,
  text,
  diagnostics: [],
  ...patch,
});

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const command of [commands.discover, commands.start, commands.list, commands.cancel])
    command.mockReset();
  commands.open.mockReset();
  commands.subscribed.mockReset();
  commands.view.current = null;
  commands.list.mockResolvedValue({ _tag: "Success", value: [] });
  commands.discover.mockResolvedValue({ _tag: "Success", value: discovery });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
const content = () => text(renderer!.root);
const button = (label: string) =>
  renderer!.root.find(
    (node) =>
      node.type === "button" && (text(node).includes(label) || node.props["aria-label"] === label),
  );
async function press(label: string) {
  await act(async () => button(label).props.onClick());
}
async function mount(props: Partial<Parameters<typeof SimBuildBar>[0]> = {}) {
  const element = (next: Partial<Parameters<typeof SimBuildBar>[0]>) => (
    <SimBuildBar
      environmentId={environmentId}
      threadId={threadId}
      projectId={projectId}
      device={device}
      hostSupport="mac"
      visible
      openRequest={0}
      {...props}
      {...next}
    />
  );
  await act(async () => {
    renderer = create(element({}));
  });
  return (next: Partial<Parameters<typeof SimBuildBar>[0]>) =>
    act(async () => renderer!.update(element(next)));
}

it("explains SSH hosts, non-Mac environments and unattached threads without discovering", async () => {
  await mount({ device: { ...device, hostId: "ssh-host" } });
  expect(content()).toContain("Simulators on SSH device hosts can't receive builds yet.");
  expect(button("Run on iPhone 17…").props.disabled).toBe(true);
  await act(async () => renderer!.unmount());

  await mount({ hostSupport: "not-mac" });
  expect(content()).toContain("need this project's environment to run on a Mac");
  await act(async () => renderer!.unmount());

  commands.list.mockClear();
  await mount({ projectId: null });
  expect(content()).toContain("Attach a project to this thread");
  expect(commands.discover).not.toHaveBeenCalled();
  expect(commands.list).not.toHaveBeenCalled();
});

it("discovers, starts the chosen scheme on the panel's simulator, and streams the job", async () => {
  await mount();
  expect(commands.list).toHaveBeenCalledWith({ environmentId, input: context });
  await press("Run on iPhone 17…");
  expect(commands.discover).toHaveBeenCalledWith({ environmentId, input: context });
  commands.start.mockResolvedValue({ _tag: "Success", value: job({ phase: "resolving" }) });
  await act(async () =>
    renderer!.root.find((node) => node.type === "button" && text(node) === "Run").props.onClick(),
  );
  expect(commands.start).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({
      ...context,
      hostId: "local",
      deviceId: "sim-1",
      action: "run",
      containerPath: "App.xcodeproj",
      scheme: "App",
      requestId: expect.any(String),
    }),
  });
  expect(commands.subscribed).toHaveBeenCalledWith({
    environmentId,
    input: { ...context, jobId: "job-1" },
  });
  expect(content()).toContain("Run App on iPhone 17");
  expect(content()).toContain("Resolving");
  expect(button("Cancel")).toBeDefined();
});

it("offers Xcode setup when the environment has no full Xcode selected", async () => {
  commands.discover.mockResolvedValue({
    _tag: "Failure",
    cause: {
      _tag: "SimBuildError",
      code: "unavailable",
      message: "Select a full Xcode installation in Xcode setup first.",
    },
  });
  const update = await mount();
  // The palette request opens the form the same way the button does.
  await update({ openRequest: 1 });
  expect(content()).toContain("Select a full Xcode installation");
  expect(renderer!.root.findByType("a").props.href).toBe("/settings/xcode");
});

it("shows Expo prebuild guidance when no native project exists", async () => {
  commands.discover.mockResolvedValue({
    _tag: "Success",
    value: {
      ...discovery,
      framework: "expo",
      containers: [],
      notices: [
        "Generate the native ios/ project with Expo prebuild before running on a simulator.",
      ],
    },
  });
  await mount();
  await press("Run on iPhone 17…");
  expect(content()).toContain("Expo prebuild");
});

it("links diagnostics to the editor, flags trimmed output, cancels, and runs a failed job again", async () => {
  commands.list.mockResolvedValue({ _tag: "Success", value: [job()] });
  commands.view.current = {
    job: job(),
    receipts: [],
    logs: [
      chunk(4, "CompileSwift App.swift\n", {
        diagnostics: [
          {
            severity: "error",
            message: "cannot find 'foo' in scope",
            file: "/repo/App/App.swift",
            line: 12,
            column: 5,
          },
          { severity: "warning", message: "linker note", file: null, line: null, column: null },
        ],
      }),
    ],
    nextLogSequence: 5,
    logsTruncated: true,
  };
  const update = await mount();
  expect(content()).toContain("Earlier output was trimmed");
  expect(content()).toContain("1 error, 1 warning");
  commands.open.mockResolvedValue({ _tag: "Success", value: "vscode" });
  await press("App/App.swift:12:5");
  expect(commands.open).toHaveBeenCalledWith("/repo/App/App.swift:12:5");

  commands.cancel.mockResolvedValue({
    _tag: "Success",
    value: job({ phase: "cancelled", terminal: true }),
  });
  await press("Cancel");
  expect(commands.cancel).toHaveBeenCalledWith({
    environmentId,
    input: { ...context, jobId: "job-1" },
  });

  const failed = job({
    phase: "failed",
    terminal: true,
    failure: { code: "process-failed", message: "xcodebuild exited with code 65." },
  });
  commands.view.current = { ...commands.view.current, job: failed };
  await update({});
  expect(content()).toContain("xcodebuild exited with code 65.");
  commands.start.mockResolvedValue({
    _tag: "Success",
    value: job({ id: "job-2", requestId: "request-2" }),
  });
  await press("Run again");
  const started = commands.start.mock.calls[0]![0] as {
    input: { requestId: string; scheme: string };
  };
  expect(started.input.scheme).toBe("App");
  expect(started.input.requestId).not.toBe("request-1");
  expect(button("Change settings")).toBeDefined();
});

it("releases the subscription while hidden without cancelling", async () => {
  commands.list.mockResolvedValue({ _tag: "Success", value: [job()] });
  const update = await mount();
  commands.subscribed.mockClear();
  await update({ visible: false });
  expect(commands.subscribed).not.toHaveBeenCalled();
  expect(commands.cancel).not.toHaveBeenCalled();
});
