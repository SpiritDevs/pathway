import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";

// convex-test runs functions through the npm `convex` builders, and Cyndrbase has no in-process
// harness yet, so tests swap cyndrbase/* for the Convex modules it mirrors (see tsconfig.test.json).
export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      alias: { "cyndrbase/server": "convex/server", "cyndrbase/values": "convex/values" },
    },
  }),
);
