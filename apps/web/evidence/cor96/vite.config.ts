import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 6273,
    strictPort: true,
    fs: { allow: [new URL("../../../..", import.meta.url).pathname] },
  },
  resolve: {
    alias: { "~": new URL("../../src", import.meta.url).pathname },
    dedupe: ["react", "react-dom"],
  },
});
