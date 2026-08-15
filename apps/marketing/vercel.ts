import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  installCommand: "npm install -g vite-plus && vp install --filter '@spiritdevs/marketing...'",
  buildCommand: "vp run --filter @spiritdevs/marketing build",
  outputDirectory: "dist",
};
