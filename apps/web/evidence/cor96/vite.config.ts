import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execFileSync } from "node:child_process";
export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [
    process.env.COR96_BASELINE === "1" && {
      name: "cor96-before-fixture",
      enforce: "pre",
      load(id) {
        if (!id.endsWith("/orchestrator/ConversationMetadata.tsx")) return;
        return execFileSync(
          "git",
          ["show", "a26f42e0ed:apps/web/src/components/orchestrator/ConversationMetadata.tsx"],
          { encoding: "utf8" },
        );
      },
    },
    react(),
    tailwindcss(),
  ],
  server: {
    host: "127.0.0.1",
    port: process.env.COR96_BASELINE === "1" ? 6274 : 6273,
    strictPort: true,
    fs: { allow: [new URL("../../../..", import.meta.url).pathname] },
  },
  resolve: {
    alias: { "~": new URL("../../src", import.meta.url).pathname },
    dedupe: ["react", "react-dom"],
  },
});
