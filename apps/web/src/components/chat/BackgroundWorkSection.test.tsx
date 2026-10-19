import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { BackgroundWorkSection } from "./BackgroundWorkSection";

const props = {
  tasks: [{ taskId: "codex-command", description: "bun run dev --port 3456" }],
  canStop: true,
  stopping: false,
  onStop: vi.fn(),
};

describe("background work recovery", () => {
  it("shows provider-owned work without requiring a running turn or a Pathway terminal", () => {
    const html = renderToStaticMarkup(<BackgroundWorkSection {...props} />);
    expect(html).toContain("bun run dev --port 3456");
    expect(html).toContain("Stop work and settle");
    expect(html).toContain("cancels queued messages");
    expect(html).not.toContain('disabled=""');
  });

  it("disappears when no background work remains", () => {
    expect(renderToStaticMarkup(<BackgroundWorkSection {...props} tasks={[]} />)).toBe("");
  });

  it("labels provider tasks that do not include a description", () => {
    const html = renderToStaticMarkup(
      <BackgroundWorkSection {...props} tasks={[{ taskId: "provider-task" }]} />,
    );
    expect(html).toContain("Background task");
  });

  it("disables repeated requests while stopping", () => {
    const html = renderToStaticMarkup(<BackgroundWorkSection {...props} stopping />);
    expect(html).toContain('disabled=""');
    expect(html).toContain("Stopping work…");
  });

  it("explains unsupported environments instead of offering an ineffective action", () => {
    const html = renderToStaticMarkup(<BackgroundWorkSection {...props} canStop={false} />);
    expect(html).toContain('disabled=""');
    expect(html).toContain("Update the connected environment");
  });

  it("does not offer settlement that would delete a temporary conversation", () => {
    const html = renderToStaticMarkup(<BackgroundWorkSection {...props} temporary />);
    expect(html).toContain('disabled=""');
    expect(html).toContain("Keep this conversation");
  });
});

it("keeps the task summary on one line with details collapsed", () => {
  const html = renderToStaticMarkup(<BackgroundWorkSection {...props} />);
  expect(html).toContain("truncate");
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('hidden=""');
  expect(html).toContain('aria-label="Show background work details"');
});

it("summarizes additional tasks without adding collapsed rows", () => {
  const html = renderToStaticMarkup(
    <BackgroundWorkSection
      {...props}
      tasks={[...props.tasks, { taskId: "another-task", description: "Check deployment" }]}
    />,
  );
  expect(html).toContain(">+1</span>");
  expect(html).toContain("Check deployment");
  expect(html).toContain('hidden=""');
});
