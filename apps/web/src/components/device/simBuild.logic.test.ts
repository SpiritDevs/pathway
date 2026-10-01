import { describe, expect, it } from "vite-plus/test";
import type { SimBuildContainer, SimBuildJob } from "@spiritdevs/contracts/simBuild";

import {
  currentSimBuildJob,
  defaultSimBuildSelection,
  simBuildBlocker,
  simBuildContainerInventory,
  simBuildDiagnosticLocation,
  simBuildDiagnostics,
  simBuildDiagnosticTarget,
  simBuildFailure,
} from "./simBuild.logic";

const project: SimBuildContainer = {
  path: "ios/App.xcodeproj",
  kind: "project",
  schemes: ["App"],
  targets: ["App", "Widget"],
  configurations: ["Debug", "Release"],
};
const workspace: SimBuildContainer = {
  path: "ios/App.xcworkspace",
  kind: "workspace",
  schemes: ["App", "Pods"],
  targets: [],
  configurations: [],
};

describe("simBuild logic", () => {
  it("blocks Android, SSH hosts, non-Mac environments and unattached threads", () => {
    const ios = { hostId: "local", platform: "ios" } as const;
    expect(simBuildBlocker({ device: ios, hostSupport: "mac", projectId: "p" })).toBeNull();
    expect(simBuildBlocker({ device: ios, hostSupport: "unknown", projectId: "p" })).toBeNull();
    expect(
      simBuildBlocker({
        device: { ...ios, platform: "android" },
        hostSupport: "mac",
        projectId: "p",
      }),
    ).toContain("iOS");
    expect(
      simBuildBlocker({ device: { ...ios, hostId: "ssh" }, hostSupport: "mac", projectId: "p" }),
    ).toContain("SSH");
    expect(simBuildBlocker({ device: ios, hostSupport: "not-mac", projectId: "p" })).toContain(
      "Mac",
    );
    expect(simBuildBlocker({ device: ios, hostSupport: "mac", projectId: null })).toContain(
      "Attach a project",
    );
  });

  it("prefers a workspace and keeps a still-valid previous choice", () => {
    const selection = defaultSimBuildSelection({ containers: [project, workspace] }, null);
    expect(selection).toEqual({
      containerPath: workspace.path,
      scheme: "App",
      configuration: null,
      target: null,
      action: "run",
    });
    const previous = { ...selection!, scheme: "Pods", action: "test" as const };
    expect(defaultSimBuildSelection({ containers: [project, workspace] }, previous)).toBe(previous);
    expect(defaultSimBuildSelection({ containers: [project] }, previous)).toMatchObject({
      containerPath: project.path,
      action: "test",
    });
    expect(defaultSimBuildSelection({ containers: [] }, null)).toBeNull();
  });

  it("lends a workspace its projects' targets and configurations", () => {
    expect(simBuildContainerInventory([project, workspace], workspace.path)).toEqual({
      targets: ["App", "Widget"],
      configurations: ["Debug", "Release"],
    });
    expect(simBuildContainerInventory([project], "missing")).toEqual({
      targets: [],
      configurations: [],
    });
  });

  it("orders errors first, bounds the list and formats editor targets", () => {
    const logs = [
      {
        sequence: 1,
        text: "",
        diagnostics: [
          { severity: "warning" as const, message: "w", file: null, line: null, column: null },
          { severity: "error" as const, message: "e", file: "/repo/A.swift", line: 3, column: 7 },
        ],
      },
    ];
    const result = simBuildDiagnostics(logs);
    expect(result.items.map((item) => item.message)).toEqual(["e", "w"]);
    expect(result).toMatchObject({ errors: 1, warnings: 1 });
    const many = [{ sequence: 2, text: "", diagnostics: Array(80).fill(logs[0]!.diagnostics[1]) }];
    expect(simBuildDiagnostics(many).items).toHaveLength(50);
    expect(simBuildDiagnosticTarget(logs[0]!.diagnostics[1]!)).toBe("/repo/A.swift:3:7");
    expect(simBuildDiagnosticTarget({ file: "/repo/A.swift", line: 3, column: null })).toBe(
      "/repo/A.swift:3",
    );
    expect(simBuildDiagnosticTarget(logs[0]!.diagnostics[0]!)).toBeNull();
    expect(simBuildDiagnosticLocation(logs[0]!.diagnostics[1]!, "/repo")).toBe("A.swift:3:7");
  });

  it("reads typed failures and picks the active or newest job", () => {
    expect(simBuildFailure({ _tag: "SimBuildError", code: "busy", message: "Busy" })).toEqual({
      code: "busy",
      message: "Busy",
    });
    expect(simBuildFailure(new Error("socket closed"))).toBeNull();
    const old = { id: "a", terminal: true, createdAt: 1 } as SimBuildJob;
    const newer = { id: "b", terminal: true, createdAt: 2 } as SimBuildJob;
    const active = { id: "c", terminal: false, createdAt: 0 } as SimBuildJob;
    expect(currentSimBuildJob([old, newer])?.id).toBe("b");
    expect(currentSimBuildJob([old, active, newer])?.id).toBe("c");
    expect(currentSimBuildJob([])).toBeNull();
  });
});
