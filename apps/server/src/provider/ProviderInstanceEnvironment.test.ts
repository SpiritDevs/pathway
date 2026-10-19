import { describe, expect, it } from "vite-plus/test";

import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });
});

describe("provider child environment", () => {
  it("never passes Computer host authority to a provider child", () => {
    const env = mergeProviderInstanceEnvironment(
      [{ name: "PATHWAY_CUA_HOST_SOCKET", value: "/tmp/injected.sock", sensitive: false }],
      {
        PATH: "/bin",
        PATHWAY_BROWSER_HOST_CAPABILITY: "secret",
        PATHWAY_BROWSER_HOST_CAPABILITY_FD: "3",
        PATHWAY_CUA_HOST_SOCKET: "/tmp/cua.sock",
        PATHWAY_HOME: "/home/pathway",
      },
    );
    expect(env).toEqual({ PATH: "/bin", PATHWAY_HOME: "/home/pathway" });
  });
});
