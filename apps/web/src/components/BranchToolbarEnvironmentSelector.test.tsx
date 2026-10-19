import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId, ProjectId } from "@spiritdevs/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";

vi.mock("@clerk/react", () => ({ useAuth: () => ({ userId: "test-user" }) }));
vi.mock("../hooks/useStoragePressure", () => ({ useStoragePressure: () => [] }));

const select = vi.hoisted(() => ({ change: undefined as ((value: string) => void) | undefined }));

// Render the normally portalled popup so these unit tests can inspect its
// choices and exercise selection without opening a browser.
vi.mock("./ui/select", () => ({
  Select: ({
    children,
    onValueChange,
  }: {
    children: ReactNode;
    onValueChange: (value: string) => void;
  }) => {
    select.change = onValueChange;
    return <div>{children}</div>;
  },
  SelectGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectGroupLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectPopup: ({ children }: { children: ReactNode }) => <div data-popup>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => (
    <button aria-label="Run on">{children}</button>
  ),
  SelectValue: () => <span>Selected environment</span>,
  SelectSeparator: () => <hr />,
  SelectItem: ({
    children,
    value,
    disabled,
  }: {
    children: ReactNode;
    value: string;
    disabled?: boolean;
  }) => (
    <button data-value={value} disabled={disabled}>
      {children}
    </button>
  ),
}));

const environment = {
  environmentId: EnvironmentId.make("studio"),
  projectId: ProjectId.make("pathway"),
  label: "Mac Studio",
  isPrimary: true,
};

beforeEach(() => {
  select.change = undefined;
});

describe("BranchToolbarEnvironmentSelector", () => {
  it.each(["toolbar", "panel"] as const)(
    "offers Auto first and a manual override for one environment in the %s",
    (displayMode) => {
      const onAuto = vi.fn();
      const onEnvironmentChange = vi.fn();
      const html = renderToStaticMarkup(
        <BranchToolbarEnvironmentSelector
          displayMode={displayMode}
          envLocked={false}
          environmentId={environment.environmentId}
          availableEnvironments={[environment]}
          onEnvironmentChange={onEnvironmentChange}
          autoPlacement={{
            active: true,
            disabled: false,
            label: "Auto: Mac Studio",
            onSelect: onAuto,
          }}
        />,
      );
      expect(html).toContain('aria-label="Run on"');
      expect(html).toMatch(
        /data-value="__auto-placement__">Auto: Mac Studio<\/button><hr\/><button data-value="studio"/,
      );
      expect(html).not.toContain("disabled");
      expect(html).not.toContain("Manual placement");
      select.change?.(environment.environmentId);
      expect(onEnvironmentChange).toHaveBeenCalledWith(environment.environmentId);
      select.change?.("__auto-placement__");
      expect(onAuto).toHaveBeenCalledOnce();
      expect(onEnvironmentChange).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps Auto reachable when it is the only selection callback", () => {
    renderToStaticMarkup(
      <BranchToolbarEnvironmentSelector
        envLocked={false}
        environmentId={environment.environmentId}
        availableEnvironments={[environment]}
        autoPlacement={{
          active: false,
          disabled: false,
          label: "Auto: Mac Studio",
          onSelect: vi.fn(),
        }}
      />,
    );
    expect(select.change).toBeDefined();
  });

  it("omits Auto when load balancing is off", () => {
    const html = renderToStaticMarkup(
      <BranchToolbarEnvironmentSelector
        envLocked={false}
        environmentId={environment.environmentId}
        availableEnvironments={[environment]}
        onEnvironmentChange={vi.fn()}
      />,
    );
    expect(html).not.toContain("__auto-placement__");
    expect(html).toContain('data-value="studio"');
  });
});
