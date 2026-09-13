import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ThreadId,
  type AssetResource,
  type AssetCreateUrlResult,
} from "@spiritdevs/contracts";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import { renderToStaticMarkup } from "react-dom/server";
import ChatMarkdown from "./ChatMarkdown";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  connected: true,
  failure: false,
  expired: false,
  activeEnvironment: "elsewhere",
  requests: [] as unknown[],
}));
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  usePreparedConnection: (id: string) =>
    state.connected ? Option.some({ httpBaseUrl: `https://${id}.example` }) : Option.none(),
}));
vi.mock("../state/environments", async (original) => ({
  ...(await original<typeof import("../state/environments")>()),
  usePrimaryEnvironmentId: () => EnvironmentId.make(state.activeEnvironment),
  useEnvironmentConnectionState: () => ({
    data: { phase: state.connected ? "connected" : "disconnected" },
  }),
}));
vi.mock("../state/assets", () => ({
  assetEnvironment: {
    createUrl: (target: { environmentId: string; input: { resource: AssetResource } }) => {
      state.requests.push(target);
      return Atom.make(
        state.failure
          ? AsyncResult.failure(Cause.fail(new Error("File unavailable")))
          : AsyncResult.success<AssetCreateUrlResult>({
              relativeUrl:
                target.input.resource._tag === "visualization-file"
                  ? "/api/assets/signed/preview.html"
                  : "/api/assets/signed/image.jpg",
              expiresAt: state.expired ? 0 : Date.now() + 3_600_000,
            }),
      );
    },
  },
}));

function render(text: string, environment: string | null = "owner") {
  const registry = AtomRegistry.make();
  try {
    return renderToStaticMarkup(
      <RegistryContext value={registry}>
        <ChatMarkdown
          cwd={undefined}
          text={text}
          threadRef={
            environment
              ? {
                  environmentId: EnvironmentId.make(environment),
                  threadId: ThreadId.make("same-thread"),
                }
              : undefined
          }
        />
      </RegistryContext>,
    );
  } finally {
    registry.dispose();
  }
}

beforeEach(() => {
  state.connected = true;
  state.failure = false;
  state.expired = false;
  state.requests = [];
});

describe("conversation visualizations", () => {
  const path = "/tmp/pathway-background-services-97f9e984/background-services.html";
  const marker = `visualize${JSON.stringify({ path })}`;

  it("renders historical markers as browser cards through their owning environment", () => {
    const html = render(`Here's a mockup.\n\n${marker}`, "remote-owner");
    expect(html).toContain("background services");
    expect(html).toContain('href="https://remote-owner.example/api/assets/signed/preview.html"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain("");
    expect(state.requests).toEqual([
      {
        environmentId: "remote-owner",
        input: { resource: { _tag: "visualization-file", threadId: "same-thread", path } },
      },
    ]);
    state.activeEnvironment = "unrelated";
    expect(render(marker, "remote-owner")).toContain('href="https://remote-owner.example/');
  });

  it("preserves JSON escapes and treats titles as plain text", () => {
    const path = String.raw`C:\scratch\some_file.html`;
    const title = "A **bold** <script> title";
    const html = render(`visualize${JSON.stringify({ path, title, mode: "wide" })}`);
    expect(html).toContain("A **bold** &lt;script&gt; title");
    expect(state.requests).toContainEqual({
      environmentId: "owner",
      input: {
        resource: { _tag: "visualization-file", threadId: "same-thread", path },
      },
    });
  });

  it("keeps fenced and inline examples literal and ignores incomplete or invalid markers", () => {
    for (const value of [
      "```text\n" + marker + "\n```",
      "`" + marker + "`",
      "visualize{",
      'visualize{"path":"https://evil.example/a.html"}',
    ]) {
      expect(render(value)).not.toContain("Open visualization in browser");
    }
    expect(state.requests).toEqual([]);
  });

  it("shows an unavailable state for disconnected environments and missing files", () => {
    expect(render(marker, null)).toContain("Visualization unavailable");
    state.connected = false;
    expect(render(marker)).toContain("Visualization unavailable");
    state.connected = true;
    state.failure = true;
    expect(render(marker)).toContain("Retry visualization");
  });
});

describe("conversation Markdown images", () => {
  it("requests the exact historical path through the owning environment's workspace asset", () => {
    const path = "/Users/coreybaines/GitHub/pathway/.pathway/evidence/thread-environment-right.jpg";
    const markdown = `![Environment name aligned beside the agent icon](${path})`;
    const html = render(markdown);
    expect(state.requests).toEqual([
      {
        environmentId: "owner",
        input: { resource: { _tag: "workspace-file", threadId: "same-thread", path } },
      },
    ]);
    expect(html).toContain('src="https://owner.example/api/assets/signed/image.jpg"');
    expect(html).toContain('alt="Environment name aligned beside the agent icon"');
    expect(html).not.toContain(' src="/Users/');
    state.activeEnvironment = "different";
    expect(render(markdown)).toBe(html);
    expect(render(markdown, "second")).toContain('src="https://second.example/api/assets/');
    expect(markdown).not.toContain("/api/assets/");
  });

  it.each([
    ["file:///Users/me/a%20b.png", "/Users/me/a b.png"],
    ["C:/work/image.png", "C:/work/image.png"],
    [String.raw`C:\work\image.png`, String.raw`C:\work\image.png`],
    ["./screens/你好%20world.png", "./screens/你好 world.png"],
    ["./a%23b%3Fc.png", "./a#b?c.png"],
  ])("resolves %s through the full Markdown sanitizer", (source, path) => {
    expect(render(`![Alt](${source})`)).toContain('src="https://owner.example/api/assets/');
    expect(state.requests).toContainEqual({
      environmentId: "owner",
      input: { resource: { _tag: "workspace-file", threadId: "same-thread", path } },
    });
  });

  it("preserves linked HTTPS images without requesting an environment asset", () => {
    const html = render("[![Example](https://images.example/a.png)](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('src="https://images.example/a.png"');
    expect(state.requests).toEqual([]);
  });

  it("has useful fallbacks for missing context, disconnection, missing or denied files, and expiry", () => {
    const markdown = "![Screenshot](./image.png)";
    expect(render(markdown, null)).toContain("Image unavailable");
    expect(state.requests).toEqual([]);
    state.connected = false;
    expect(render(markdown)).toContain("Image unavailable");
    state.connected = true;
    state.failure = true;
    expect(render(markdown)).toContain("Retry image");
    state.failure = false;
    state.expired = true;
    expect(render(markdown)).not.toContain("<img");
  });
});
