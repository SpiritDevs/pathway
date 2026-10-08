import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { SubagentComposerBar } from "./SubagentComposerBar";

function renderBar(messagingAvailable: boolean | null) {
  return renderToStaticMarkup(
    <SubagentComposerBar
      provider={null}
      showInstanceBadge={false}
      modelLabel="Test model"
      effortLabel="High"
      status={{ phase: "working", startedAt: "2026-10-08T10:00:00.000Z", completedAt: null }}
      messagingAvailable={messagingAvailable}
      onMessage={messagingAvailable === true ? () => undefined : null}
      onOpenParent={() => undefined}
    />,
  );
}

describe("subagent composer bar", () => {
  it("distinguishes loading ownership from a provider-native child", () => {
    const loading = renderBar(null);
    expect(loading).toContain("Loading subagent");
    expect(loading).not.toContain("Runs on its own");
    expect(loading).not.toContain(">Message<");
    const native = renderBar(false);
    expect(native).toContain("Runs on its own");
    expect(native).not.toContain(">Message<");
    expect(renderBar(true)).toContain("Message");
  });

  it("uses the dark composer surface and announces status without a ticking live region", () => {
    const html = renderBar(true);
    expect(html).toContain('data-chat-composer-content-sized="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Test model, High subagent: Working");
    expect(html).toContain('aria-hidden="true"');
  });
});
